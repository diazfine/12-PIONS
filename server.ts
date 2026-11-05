import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { getRandomVirtualProfile, VirtualProfile } from './src/utils/virtualProfiles';
import {
  chooseBestAIMove,
  getAIMoves,
  calculateValidMoves,
  applyPromotions,
  countPieces,
  cloneBoard,
  getBoardKey,
} from './src/utils/gameLogic';

// Helper function to create initial 5x5 grid (Row 0-1: Green, Row 2: 2 Green, center empty, 2 Red, Row 3-4: Red)
function getInitialBoardState() {
  const b: any[][] = [];
  for (let r = 0; r < 5; r++) {
    b[r] = [];
    for (let c = 0; c < 5; c++) {
      b[r][c] = null;
    }
  }
  for (let c = 0; c < 5; c++) {
    b[0][c] = { c: 'green', d: false };
    b[1][c] = { c: 'green', d: false };
  }
  b[2][0] = { c: 'green', d: false };
  b[2][1] = { c: 'green', d: false };
  b[2][2] = null;
  b[2][3] = { c: 'red', d: false };
  b[2][4] = { c: 'red', d: false };
  for (let c = 0; c < 5; c++) {
    b[3][c] = { c: 'red', d: false };
    b[4][c] = { c: 'red', d: false };
  }
  return b;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // WebSocket Server for 12 PIONS on /ws
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('error', () => {});
          wss.emit('connection', ws, req);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  interface ClientMeta {
    roomId?: string;
    role?: 'host' | 'guest';
    playerId?: string;
    playerName?: string;
    avatar?: string;
    customPhoto?: string;
    flag?: string;
    color?: 'green' | 'red';
  }

  interface RoomState {
    id: string;
    hostWs: WebSocket | null;
    guestWs: WebSocket | null;
    hostMeta: ClientMeta | null;
    guestMeta: ClientMeta | null;
    board: any[][];
    currentTurn: 'green' | 'red';
    gameStarted: boolean;
    gameOver: boolean;
    winner?: 'green' | 'red' | 'draw';
    gameOverReason?: string;
    movesWithoutCapture: number;
    timerSec: number;
    timerInterval: NodeJS.Timeout | null;
    watchdogTimeout: NodeJS.Timeout | null;
    disconnectTimeout: NodeJS.Timeout | null;
    disconnectInterval?: NodeJS.Timeout | null;
    disconnectBufferSec?: number;
    isPausedForReconnect?: boolean;
    rematchRequestedBy?: 'host' | 'guest';
    turnId: number;
    consecutiveTimeouts: { green: number; red: number };
    isBotMatch?: boolean;
    botProfile?: VirtualProfile;
    botColor?: 'green' | 'red';
    botTimeout?: NodeJS.Timeout | null;
    posHistory?: string[];
  }

  const D4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function countPiecesOnBoard(b: any[][]) {
    let green = 0;
    let red = 0;
    if (!b || !Array.isArray(b)) return { green: 0, red: 0 };
    for (let r = 0; r < b.length; r++) {
      for (let c = 0; c < (b[r]?.length || 0); c++) {
        const p = b[r][c];
        if (!p) continue;
        if (p.c === 'green') green++;
        else if (p.c === 'red') red++;
      }
    }
    return { green, red };
  }

  // ⚖️ RÈGLE DES 50 COUPS SANS PRISE : Comparaison des pions restants
  // Si un joueur a plus de pions, il est déclaré Vainqueur. Match Nul seulement si stricte égalité.
  function resolve50MovesWinner(b: any[][]): { winner: 'green' | 'red' | 'draw'; greenCount: number; redCount: number; message: string } {
    const { green, red } = countPiecesOnBoard(b);
    if (green > red) {
      return {
        winner: 'green',
        greenCount: green,
        redCount: red,
        message: `⚖️ 50 coups sans prise atteints : Victoire des Verts (${green} vs ${red} pions) !`,
      };
    } else if (red > green) {
      return {
        winner: 'red',
        greenCount: green,
        redCount: red,
        message: `⚖️ 50 coups sans prise atteints : Victoire des Rouges (${red} vs ${green} pions) !`,
      };
    } else {
      return {
        winner: 'draw',
        greenCount: green,
        redCount: red,
        message: `⚖️ 50 coups sans prise atteints : Match Nul (${green} vs ${red} pions) !`,
      };
    }
  }

  // 🛡️ DÉTECTION OFFICIELLE DES COUPS LÉGAUX (Validation synchrone anti-blocage)
  function hasLegalMoves(b: any[][], color: 'green' | 'red'): boolean {
    if (!b || !Array.isArray(b) || b.length !== 5) return false;
    const D4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const p = b[r]?.[c];
        if (!p || p.c !== color) continue;

        // 1. Vérification des captures (prioritaires)
        if (p.d) {
          // Dame : glisse dans chaque direction orthogonale
          for (const [dr, dc] of D4) {
            let step = 1;
            while (true) {
              const nr = r + dr * step;
              const nc = c + dc * step;
              if (nr < 0 || nr >= 5 || nc < 0 || nc >= 5) break;
              const mid = b[nr][nc];
              if (!mid) {
                step++;
                continue;
              }
              if (mid.c === color) break; // Bloqué par allié
              // Pièce adverse trouvée : vérifie case vide juste derrière
              const landR = nr + dr;
              const landC = nc + dc;
              if (landR >= 0 && landR < 5 && landC >= 0 && landC < 5 && !b[landR][landC]) {
                return true; // Capture de Dame légale disponible
              }
              break;
            }
          }
        } else {
          // Pion simple : saut orthogonal de 2 cases par-dessus une pièce adverse
          for (const [dr, dc] of D4) {
            const midR = r + dr;
            const midC = c + dc;
            const landR = r + dr * 2;
            const landC = c + dc * 2;
            if (landR >= 0 && landR < 5 && landC >= 0 && landC < 5) {
              const mid = b[midR]?.[midC];
              if (mid && mid.c !== color && !b[landR]?.[landC]) {
                return true; // Capture de pion simple légale disponible
              }
            }
          }
        }

        // 2. Vérification des déplacements simples (sans capture)
        if (p.d) {
          // Dame : peut se déplacer sur toute case vide orthogonale
          for (const [dr, dc] of D4) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < 5 && nc >= 0 && nc < 5 && !b[nr]?.[nc]) {
              return true;
            }
          }
        } else {
          // Pion simple : avance (Vert: +1, Rouge: -1) ou latéral (gauche/droite)
          const fwd = color === 'green' ? 1 : -1;
          const dirs = [
            [fwd, 0],
            [0, -1],
            [0, 1],
          ];
          for (const [dr, dc] of dirs) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < 5 && nc >= 0 && nc < 5 && !b[nr]?.[nc]) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  function hasCaptureMoves(b: any[][], color: 'green' | 'red'): boolean {
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const p = b[r]?.[c];
        if (!p || p.c !== color) continue;

        if (p.d) {
          for (const [dr, dc] of D4) {
            let step = 1;
            while (true) {
              const nr = r + dr * step;
              const nc = c + dc * step;
              if (nr < 0 || nr >= 5 || nc < 0 || nc >= 5) break;
              const mid = b[nr][nc];
              if (!mid) {
                step++;
                continue;
              }
              if (mid.c === color) break;
              const landR = nr + dr;
              const landC = nc + dc;
              if (landR >= 0 && landR < 5 && landC >= 0 && landC < 5 && !b[landR][landC]) {
                return true;
              }
              break;
            }
          }
        } else {
          for (const [dr, dc] of D4) {
            const midR = r + dr;
            const midC = c + dc;
            const landR = r + dr * 2;
            const landC = c + dc * 2;
            if (landR >= 0 && landR < 5 && landC >= 0 && landC < 5) {
              const mid = b[midR]?.[midC];
              if (mid && mid.c !== color && !b[landR]?.[landC]) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  }

  const clients = new Map<WebSocket, ClientMeta>();
  const rooms = new Map<string, RoomState>();

  // Matchmaking queue: single waiting player slot for instant 2-device pairing
  let waitingPlayer: {
    ws: WebSocket;
    playerId: string;
    playerName: string;
    avatar?: string;
    customPhoto?: string;
    flag?: string;
    region?: string;
    preferredColor?: 'green' | 'red' | 'random';
    botTimer?: NodeJS.Timeout | null;
  } | null = null;

  function stopRoomTimer(room: RoomState) {
    if (room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }
    if (room.watchdogTimeout) {
      clearTimeout(room.watchdogTimeout);
      room.watchdogTimeout = null;
    }
    if (room.disconnectTimeout) {
      clearTimeout(room.disconnectTimeout);
      room.disconnectTimeout = null;
    }
    if (room.disconnectInterval) {
      clearInterval(room.disconnectInterval);
      room.disconnectInterval = null;
    }
    // Only cancel botTimeout if game is over
    if (room.gameOver && room.botTimeout) {
      clearTimeout(room.botTimeout);
      room.botTimeout = null;
    }
  }

  function executeBotMoveNow(room: RoomState, chainPiece?: { r: number; c: number; dir: [number, number] }) {
    if (!rooms.has(room.id) || room.gameOver || !room.isBotMatch || !room.botProfile || !room.botColor) return;
    if (room.currentTurn !== room.botColor) return;

    if (room.botTimeout) {
      clearTimeout(room.botTimeout);
      room.botTimeout = null;
    }

    const botCol = room.botColor;
    const humanCol: 'green' | 'red' = botCol === 'green' ? 'red' : 'green';
    const curBoard = room.board;
    // Niveau compétitif élevé et grand maître pour l'ensemble des 1 000 profils virtuels en ligne
    const difficulty: 'easy' | 'medium' | 'hard' = 'hard';

    let bestMove: { fr: number; fc: number; tr: number; tc: number; cr?: number; cc?: number; isCap?: boolean } | null = null;

    try {
      if (chainPiece) {
        // Enchaînement obligatoire de la multi-capture avec le même pion
        const chainMoves = calculateValidMoves(
          curBoard,
          chainPiece.r,
          chainPiece.c,
          { r: chainPiece.r, c: chainPiece.c },
          {},
          chainPiece.dir
        ).filter(m => m.t === 'c');

        if (chainMoves.length > 0) {
          const cap = chainMoves[0];
          bestMove = {
            fr: chainPiece.r,
            fc: chainPiece.c,
            tr: cap.r,
            tc: cap.c,
            cr: cap.cr,
            cc: cap.cc,
            isCap: true,
          };
        }
      }

      if (!bestMove) {
        if (!room.posHistory) room.posHistory = [];
        room.posHistory.push(getBoardKey(curBoard as any));
        bestMove = chooseBestAIMove(curBoard as any, botCol, humanCol, difficulty, room.posHistory);
      }
    } catch (err) {
      console.error('[Bot AI Warning] Recovery fallback to safe legal move:', err);
    }

    // Sécurité absolue : si l'évaluation n'a pas retourné de coup ou a levé une exception, prendre un coup légal disponible
    if (!bestMove) {
      const safeMoves = getAIMoves(curBoard as any, botCol);
      bestMove = safeMoves.length > 0 ? safeMoves[0] : null;
    }

    if (!bestMove) {
      room.gameOver = true;
      room.winner = humanCol;
      room.gameOverReason = 'blocked';
      stopRoomTimer(room);

      const stuckPayload = JSON.stringify({
        type: 'PLAYER_STUCK',
        event: 'PLAYER_STUCK',
        roomId: room.id,
        stuckColor: botCol,
        loser: botCol,
        winner: humanCol,
        gameOver: true,
        gameOverReason: 'blocked',
        message: `Fin de partie : ${room.botProfile?.name} n'a plus aucun coup valide. Victoire !`,
      });
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(stuckPayload);
      }
      return;
    }

    try {
      let nextBoard = cloneBoard(curBoard as any);
      let piece = nextBoard[bestMove.fr]?.[bestMove.fc];
      if (!piece || piece.c !== botCol) {
        const safeMoves = getAIMoves(curBoard as any, botCol);
        if (safeMoves.length > 0) {
          bestMove = safeMoves[0];
          nextBoard = cloneBoard(curBoard as any);
          piece = nextBoard[bestMove.fr]?.[bestMove.fc];
        }
      }
      if (!piece) {
        // Si la pièce sélectionnée est invalide, passer au tour de l'humain pour débloquer
        room.currentTurn = humanCol;
        startRoomTimer(room);
        return;
      }

      nextBoard[bestMove.tr][bestMove.tc] = piece;
      nextBoard[bestMove.fr][bestMove.fc] = null;

      let isCap = Boolean(bestMove.isCap);
      if (isCap && bestMove.cr !== undefined && bestMove.cc !== undefined) {
        nextBoard[bestMove.cr][bestMove.cc] = null;
      }

      applyPromotions(nextBoard, { r: bestMove.tr, c: bestMove.tc });

      // Vérification des multi-captures en chaîne pour le bot
      if (isCap) {
        const stepDir: [number, number] = [
          Math.sign((bestMove.cr ?? bestMove.tr) - bestMove.fr) || 0,
          Math.sign((bestMove.cc ?? bestMove.tc) - bestMove.fc) || 0,
        ];
        const nextCaps = calculateValidMoves(
          nextBoard,
          bestMove.tr,
          bestMove.tc,
          { r: bestMove.tr, c: bestMove.tc },
          {},
          stepDir
        ).filter(m => m.t === 'c');

        if (nextCaps.length > 0) {
          room.board = nextBoard;
          room.movesWithoutCapture = 0;

          const intermediateMoveData = {
            fr: bestMove.fr,
            fc: bestMove.fc,
            tr: bestMove.tr,
            tc: bestMove.tc,
            isCap: true,
          };

          const intermediatePayload = JSON.stringify({
            type: 'MOVE_PIECE',
            event: 'MOVE_PIECE',
            board: nextBoard,
            lastMove: intermediateMoveData,
            fr: bestMove.fr,
            fc: bestMove.fc,
            tr: bestMove.tr,
            tc: bestMove.tc,
            isCap: true,
            nextTurn: botCol,
            currentTurn: botCol,
            turn: botCol,
            isChainStep: true,
            movingColor: botCol,
            timerSec: 30,
            movesWithoutCapture: 0,
            gameOver: false,
          });

          if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
            room.hostWs.send(intermediatePayload);
          }

          scheduleBotTurn(room, { r: bestMove.tr, c: bestMove.tc, dir: stepDir });
          return;
        }
      }

      room.board = nextBoard;
      room.turnId = (room.turnId || 0) + 1;

      if (isCap) {
        room.movesWithoutCapture = 0;
      } else {
        room.movesWithoutCapture = (room.movesWithoutCapture || 0) + 1;
      }

      const counts = countPieces(nextBoard);
      let gameOverReason: string | undefined = undefined;

      if (counts.green === 0 && counts.red > 0) {
        room.gameOver = true;
        room.winner = 'red';
        gameOverReason = 'elimination';
        stopRoomTimer(room);
      } else if (counts.red === 0 && counts.green > 0) {
        room.gameOver = true;
        room.winner = 'green';
        gameOverReason = 'elimination';
        stopRoomTimer(room);
      } else if (
        counts.green === 1 &&
        counts.red === 1 &&
        !hasCaptureMoves(room.board, 'green') &&
        !hasCaptureMoves(room.board, 'red')
      ) {
        room.gameOver = true;
        room.winner = 'draw';
        gameOverReason = 'draw_1v1';
        stopRoomTimer(room);
      } else if (!hasLegalMoves(room.board, humanCol)) {
        room.gameOver = true;
        room.winner = botCol;
        gameOverReason = 'blocked';
        stopRoomTimer(room);
      } else if (room.movesWithoutCapture >= 50) {
        room.gameOver = true;
        const res50 = resolve50MovesWinner(room.board);
        room.winner = res50.winner;
        room.gameOverReason = 'draw_50_moves';
        gameOverReason = 'draw_50_moves';
        stopRoomTimer(room);
      } else {
        room.currentTurn = humanCol;
        startRoomTimer(room);
      }

      const lastMoveData = {
        fr: bestMove.fr,
        fc: bestMove.fc,
        tr: bestMove.tr,
        tc: bestMove.tc,
        isCap,
      };

      const broadcastPayload = JSON.stringify({
        type: 'MOVE_PIECE',
        event: 'MOVE_PIECE',
        board: room.board,
        lastMove: lastMoveData,
        fr: bestMove.fr,
        fc: bestMove.fc,
        tr: bestMove.tr,
        tc: bestMove.tc,
        isCap,
        nextTurn: room.currentTurn,
        turn: room.currentTurn,
        currentTurn: room.currentTurn,
        isChainStep: false,
        movingColor: botCol,
        timerSec: 30,
        movesWithoutCapture: room.movesWithoutCapture,
        gameOver: room.gameOver,
        winner: room.winner,
        gameOverReason,
      });

      const statePayload = JSON.stringify({
        type: 'GAME_STATE_UPDATE',
        event: 'GAME_STATE_UPDATE',
        board: room.board,
        currentTurn: room.currentTurn,
        turn: room.currentTurn,
        nextTurn: room.currentTurn,
        turnId: room.turnId,
        lastMove: lastMoveData,
        fr: bestMove.fr,
        fc: bestMove.fc,
        tr: bestMove.tr,
        tc: bestMove.tc,
        isCap,
        movingColor: botCol,
        timerSec: 30,
        movesWithoutCapture: room.movesWithoutCapture,
        gameOver: room.gameOver,
        winner: room.winner,
        gameOverReason,
      });

      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(statePayload);
        room.hostWs.send(broadcastPayload);
        if (room.gameOver) {
          room.hostWs.send(JSON.stringify({
            type: 'GAME_OVER',
            event: 'GAME_OVER',
            roomId: room.id,
            gameOver: true,
            winner: room.winner,
            gameOverReason: room.gameOverReason || gameOverReason,
            movesWithoutCapture: room.movesWithoutCapture,
            message: room.winner === 'draw'
              ? '⚖️ Règle des 50 coups sans prise atteinte : Match Nul !'
              : `Victoire des ${room.winner === 'green' ? 'Verts' : 'Rouges'} !`,
          }));
        }
      }

      if ((isCap || nextBoard[bestMove.tr]?.[bestMove.tc]?.d) && Math.random() < 0.25) {
        const emotes = ['👏', '🔥', '👑', '💪', '🎯'];
        const chosen = emotes[Math.floor(Math.random() * emotes.length)];
        setTimeout(() => {
          if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN && !room.gameOver) {
            room.hostWs.send(JSON.stringify({
              type: 'emote',
              payload: chosen,
              emoji: chosen,
              senderName: room.botProfile?.name,
            }));
          }
        }, 700);
      }
    } catch (err) {
      console.error('[Bot Execution Error]:', err);
      // Failsafe de déblocage ultime : avance le tour
      room.currentTurn = humanCol;
      startRoomTimer(room);
    }
  }

  function scheduleBotTurn(room: RoomState, chainPiece?: { r: number; c: number; dir: [number, number] }) {
    if (!room || room.gameOver || !room.isBotMatch || !room.botProfile || !room.botColor) return;
    if (room.currentTurn !== room.botColor) return;

    if (room.botTimeout) {
      clearTimeout(room.botTimeout);
      room.botTimeout = null;
    }

    // Réactivité fluide et dynamique : 200ms à 350ms pour un rythme de jeu rapide sans temps mort
    const thinkingDelay = chainPiece ? 150 : (200 + Math.floor(Math.random() * 150));

    room.botTimeout = setTimeout(() => {
      room.botTimeout = null;
      executeBotMoveNow(room, chainPiece);
    }, thinkingDelay);
  }

  function startBotMatch(p1: {
    ws: WebSocket;
    playerId: string;
    playerName: string;
    avatar?: string;
    customPhoto?: string;
    flag?: string;
    region?: string;
    preferredColor?: 'green' | 'red' | 'random';
  }) {
    if (!p1.ws || p1.ws.readyState !== WebSocket.OPEN) return;

    const botProfile = getRandomVirtualProfile();
    const roomId = `online_bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    let p1Color: 'green' | 'red';
    if (p1.preferredColor === 'green') p1Color = 'green';
    else if (p1.preferredColor === 'red') p1Color = 'red';
    else p1Color = Math.random() < 0.5 ? 'green' : 'red';

    const botColor: 'green' | 'red' = p1Color === 'green' ? 'red' : 'green';
    const startingTurn: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';
    const initialBoard = getInitialBoardState();

    const hostMeta: ClientMeta = {
      roomId,
      role: 'host',
      playerId: p1.playerId,
      playerName: p1.playerName,
      avatar: p1.avatar,
      customPhoto: p1.customPhoto,
      flag: p1.flag,
      color: p1Color,
    };

    const room: RoomState = {
      id: roomId,
      hostWs: p1.ws,
      guestWs: null,
      hostMeta,
      guestMeta: null,
      board: initialBoard,
      currentTurn: startingTurn,
      gameStarted: true,
      gameOver: false,
      movesWithoutCapture: 0,
      rematchRequestedBy: undefined,
      timerSec: 30,
      timerInterval: null,
      watchdogTimeout: null,
      disconnectTimeout: null,
      turnId: 0,
      consecutiveTimeouts: { green: 0, red: 0 },
      isBotMatch: true,
      botProfile,
      botColor,
      botTimeout: null,
      posHistory: [],
    };

    rooms.set(roomId, room);
    clients.set(p1.ws, hostMeta);

    p1.ws.send(JSON.stringify({
      type: 'MATCH_FOUND',
      roomId,
      role: 'host',
      myColor: p1Color,
      opponentColor: botColor,
      startingTurn,
      currentTurn: startingTurn,
      opponentName: botProfile.name,
      opponentAvatar: botProfile.avatar,
      opponentPhoto: undefined,
      opponentFlag: botProfile.flag,
      opponentCountry: botProfile.country,
      opponentLevel: botProfile.level,
      opponentRating: botProfile.rating,
      isBotMatch: true,
      message: `Adversaire trouvé ! Vous jouez contre ${botProfile.name} ${botProfile.flag}.`,
    }));

    p1.ws.send(JSON.stringify({
      type: 'START_MATCH',
      event: 'START_MATCH',
      board: initialBoard,
      startingTurn,
      currentTurn: startingTurn,
      turn: startingTurn,
      role: 'host',
      myColor: p1Color,
      opponentColor: botColor,
      hostColor: p1Color,
      guestColor: botColor,
      playerName: p1.playerName,
      opponentName: botProfile.name,
      opponentAvatar: botProfile.avatar,
      opponentPhoto: undefined,
      opponentFlag: botProfile.flag,
      opponentCountry: botProfile.country,
      opponentLevel: botProfile.level,
      opponentRating: botProfile.rating,
      roomId,
      movesWithoutCapture: 0,
      isBotMatch: true,
      payload: {
        role: 'host',
        myColor: p1Color,
        opponentColor: botColor,
        hostColor: p1Color,
        guestColor: botColor,
        playerName: p1.playerName,
        opponentName: botProfile.name,
        opponentAvatar: botProfile.avatar,
        opponentPhoto: undefined,
        opponentFlag: botProfile.flag,
        opponentCountry: botProfile.country,
        opponentLevel: botProfile.level,
        opponentRating: botProfile.rating,
        startingTurn,
        currentTurn: startingTurn,
        board: initialBoard,
        turn: startingTurn,
        roomId,
        movesWithoutCapture: 0,
        isBotMatch: true,
      },
    }));

    startRoomTimer(room);

    if (startingTurn === botColor) {
      scheduleBotTurn(room);
    }
  }

  function handleAuthoritativeTimeout(room: RoomState) {
    if (!rooms.has(room.id) || room.gameOver) return;

    // Si c'est au tour du bot virtuel, il ne doit JAMAIS perdre par forfait : exécuter son coup immédiatement
    if (room.isBotMatch && room.currentTurn === room.botColor) {
      if (room.consecutiveTimeouts) {
        room.consecutiveTimeouts[room.botColor] = 0;
      }
      executeBotMoveNow(room);
      return;
    }

    const timedOutColor = room.currentTurn;
    if (!room.consecutiveTimeouts) {
      room.consecutiveTimeouts = { green: 0, red: 0 };
    }
    const currentCount = room.consecutiveTimeouts[timedOutColor] || 0;

    if (currentCount >= 1) {
      // 🛑 RÈGLE 3 : Deuxième inactivité consécutive -> arrêt instantané, adversaire vainqueur par forfait immédiat !
      stopRoomTimer(room);
      room.gameOver = true;
      const winnerColor: 'green' | 'red' = timedOutColor === 'green' ? 'red' : 'green';
      room.winner = winnerColor;
      room.gameOverReason = 'consecutive_timeout';

      const forfeitPayload = JSON.stringify({
        type: 'FORFEIT_TIMEOUT',
        event: 'FORFEIT_TIMEOUT',
        roomId: room.id,
        winner: winnerColor,
        loser: timedOutColor,
        reason: 'consecutive_timeout',
        forfeit: true,
        message: "Victoire par forfait ! L'adversaire a laissé expirer son minuteur deux fois consécutives.",
        winnerMessage: "Victoire par forfait ! L'adversaire a laissé expirer son minuteur deux fois consécutives.",
        loserMessage: "Défaite par forfait : Deuxième expiration consécutive du minuteur (inactivité prolongée).",
      });

      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(forfeitPayload);
      }
      if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
        room.guestWs.send(forfeitPayload);
      }
      rooms.delete(room.id);
      return;
    }

    // ⚠️ PREMIÈRE INACTIVITÉ (30s sans action) :
    // Coup automatique d'IA joué à la place du joueur + 1er avertissement
    room.consecutiveTimeouts[timedOutColor] = 1;
    const opponentColor: 'green' | 'red' = timedOutColor === 'green' ? 'red' : 'green';

    const warningPayload = JSON.stringify({
      type: 'TIMEOUT_FIRST_WARNING',
      event: 'TIMEOUT_FIRST_WARNING',
      roomId: room.id,
      timedOutColor,
      currentTurn: room.currentTurn,
      consecutiveCount: 1,
      timerSec: 30,
      message: "⚠️ 1er avertissement : Temps écoulé (30s) ! Coup d'IA joué à votre place. Attention, à la deuxième inactivité consécutive, défaite immédiate par forfait !",
    });

    if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
      room.hostWs.send(warningPayload);
    }
    if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
      room.guestWs.send(warningPayload);
    }

    let bestMove: { fr: number; fc: number; tr: number; tc: number; cr?: number; cc?: number; isCap?: boolean } | null = null;
    try {
      bestMove = chooseBestAIMove(room.board as any, timedOutColor, opponentColor, 'easy', []);
    } catch (err) {
      console.error('[Timeout AI Move Error]:', err);
    }
    if (!bestMove) {
      const safeMoves = getAIMoves(room.board as any, timedOutColor);
      bestMove = safeMoves.length > 0 ? safeMoves[0] : null;
    }

    if (!bestMove) {
      // Aucun coup valide disponible : Défaite par blocage
      stopRoomTimer(room);
      room.gameOver = true;
      room.winner = opponentColor;
      room.gameOverReason = 'blocked';

      const stuckPayload = JSON.stringify({
        type: 'PLAYER_STUCK',
        event: 'PLAYER_STUCK',
        roomId: room.id,
        stuckColor: timedOutColor,
        loser: timedOutColor,
        winner: opponentColor,
        gameOver: true,
        gameOverReason: 'blocked',
        message: `Fin de partie : Aucun coup valide pour les ${timedOutColor === 'green' ? 'Verts' : 'Rouges'}. Victoire !`,
      });
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) room.hostWs.send(stuckPayload);
      if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) room.guestWs.send(stuckPayload);
      return;
    }

    try {
      // Exécution autoritaire immédiate du coup automatique sur l'échiquier officiel
      const nextBoard = cloneBoard(room.board as any);
      let movingPiece = nextBoard[bestMove.fr]?.[bestMove.fc];
      if (!movingPiece || movingPiece.c !== timedOutColor) {
        const safe = getAIMoves(room.board as any, timedOutColor);
        if (safe.length > 0) {
          bestMove = safe[0];
          movingPiece = nextBoard[bestMove.fr]?.[bestMove.fc];
        }
      }
      if (!movingPiece) {
        room.currentTurn = opponentColor;
        startRoomTimer(room);
        return;
      }

      nextBoard[bestMove.tr][bestMove.tc] = movingPiece;
      nextBoard[bestMove.fr][bestMove.fc] = null;
      const isCap = Boolean(bestMove.isCap);
      if (isCap && bestMove.cr !== undefined && bestMove.cc !== undefined) {
        nextBoard[bestMove.cr][bestMove.cc] = null;
      }
      applyPromotions(nextBoard, { r: bestMove.tr, c: bestMove.tc });
      room.board = nextBoard;

      if (isCap) {
        room.movesWithoutCapture = 0;
      } else {
        room.movesWithoutCapture = (room.movesWithoutCapture || 0) + 1;
      }

      room.turnId = (room.turnId || 0) + 1;
      const counts = countPieces(nextBoard);
      let gameOverReason: string | undefined = undefined;

      if (counts.green === 0 && counts.red > 0) {
        room.gameOver = true;
        room.winner = 'red';
        gameOverReason = 'elimination';
        stopRoomTimer(room);
      } else if (counts.red === 0 && counts.green > 0) {
        room.gameOver = true;
        room.winner = 'green';
        gameOverReason = 'elimination';
        stopRoomTimer(room);
      } else if (
        counts.green === 1 &&
        counts.red === 1 &&
        !hasCaptureMoves(room.board, 'green') &&
        !hasCaptureMoves(room.board, 'red')
      ) {
        room.gameOver = true;
        room.winner = 'draw';
        gameOverReason = 'draw_1v1';
        stopRoomTimer(room);
      } else if (!hasLegalMoves(room.board, opponentColor)) {
        room.gameOver = true;
        room.winner = timedOutColor;
        gameOverReason = 'blocked';
        stopRoomTimer(room);
      } else if (room.movesWithoutCapture >= 50) {
        room.gameOver = true;
        const res50 = resolve50MovesWinner(room.board);
        room.winner = res50.winner;
        room.gameOverReason = 'draw_50_moves';
        gameOverReason = 'draw_50_moves';
        stopRoomTimer(room);
      } else {
        room.currentTurn = opponentColor;
        startRoomTimer(room);
      }

      const lastMoveData = {
        fr: bestMove.fr,
        fc: bestMove.fc,
        tr: bestMove.tr,
        tc: bestMove.tc,
        isCap,
      };

      const autoMovePayload = JSON.stringify({
        type: 'MOVE_PIECE',
        event: 'MOVE_PIECE',
        board: room.board,
        lastMove: lastMoveData,
        fr: bestMove.fr,
        fc: bestMove.fc,
        tr: bestMove.tr,
        tc: bestMove.tc,
        isCap,
        nextTurn: room.currentTurn,
        turn: room.currentTurn,
        currentTurn: room.currentTurn,
        isChainStep: false,
        isAutoMove: true,
        wasTimeout: true,
        movingColor: timedOutColor,
        timerSec: 30,
        movesWithoutCapture: room.movesWithoutCapture,
        gameOver: room.gameOver,
        winner: room.winner,
        gameOverReason,
        message: "⚠️ Temps écoulé : Coup automatique joué par le système.",
      });

      const autoStatePayload = JSON.stringify({
        type: 'GAME_STATE_UPDATE',
        event: 'GAME_STATE_UPDATE',
        board: room.board,
        currentTurn: room.currentTurn,
        turn: room.currentTurn,
        nextTurn: room.currentTurn,
        turnId: room.turnId,
        lastMove: lastMoveData,
        fr: bestMove.fr,
        fc: bestMove.fc,
        tr: bestMove.tr,
        tc: bestMove.tc,
        isCap,
        isAutoMove: true,
        wasTimeout: true,
        movingColor: timedOutColor,
        timerSec: 30,
        movesWithoutCapture: room.movesWithoutCapture,
        gameOver: room.gameOver,
        winner: room.winner,
        gameOverReason,
        message: "⚠️ Temps écoulé : Coup automatique joué par le système.",
      });

      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(autoStatePayload);
        room.hostWs.send(autoMovePayload);
        if (room.gameOver) {
          room.hostWs.send(JSON.stringify({
            type: 'GAME_OVER',
            event: 'GAME_OVER',
            roomId: room.id,
            gameOver: true,
            winner: room.winner,
            gameOverReason: room.gameOverReason || gameOverReason,
            movesWithoutCapture: room.movesWithoutCapture,
            message: room.winner === 'draw'
              ? '⚖️ Règle des 50 coups sans prise atteinte : Match Nul !'
              : `Victoire des ${room.winner === 'green' ? 'Verts' : 'Rouges'} !`,
          }));
        }
      }
      if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
        room.guestWs.send(autoStatePayload);
        room.guestWs.send(autoMovePayload);
        if (room.gameOver) {
          room.guestWs.send(JSON.stringify({
            type: 'GAME_OVER',
            event: 'GAME_OVER',
            roomId: room.id,
            gameOver: true,
            winner: room.winner,
            gameOverReason: room.gameOverReason || gameOverReason,
            movesWithoutCapture: room.movesWithoutCapture,
            message: room.winner === 'draw'
              ? '⚖️ Règle des 50 coups sans prise atteinte : Match Nul !'
              : `Victoire des ${room.winner === 'green' ? 'Verts' : 'Rouges'} !`,
          }));
        }
      }

      if (room.isBotMatch && room.currentTurn === room.botColor && !room.gameOver) {
        scheduleBotTurn(room);
      }
    } catch (err) {
      console.error('[Timeout Execution Error]:', err);
      room.currentTurn = opponentColor;
      startRoomTimer(room);
    }
  }

  function startRoomTimer(room: RoomState) {
    stopRoomTimer(room);
    room.timerSec = 30;
    room.turnId = (room.turnId || 0) + 1;
    const currentTurnId = room.turnId;
    const turnColor = room.currentTurn;

    // Immédiatement notifier les deux clients de la réinitialisation du minuteur à 30 secondes
    const resetPayload = JSON.stringify({
      type: 'TIMER_RESET',
      roomId: room.id,
      timerSec: 30,
      currentTurn: room.currentTurn,
    });
    if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
      room.hostWs.send(resetPayload);
    }
    if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
      room.guestWs.send(resetPayload);
    }

    // Si c'est au tour du bot, s'assurer qu'il démarre immédiatement son coup
    if (room.isBotMatch && room.currentTurn === room.botColor && !room.gameOver) {
      scheduleBotTurn(room);
    }

    room.timerInterval = setInterval(() => {
      // Nettoyage immédiat si la salle n'existe plus ou si le tour a changé entre temps
      if (!rooms.has(room.id) || room.turnId !== currentTurnId || room.currentTurn !== turnColor) {
        if (room.timerInterval) {
          clearInterval(room.timerInterval);
          room.timerInterval = null;
        }
        return;
      }

      room.timerSec--;

      // Broadcast timer tick to both clients in room
      const tickPayload = JSON.stringify({
        type: 'TIMER_TICK',
        roomId: room.id,
        timerSec: Math.max(0, room.timerSec),
        currentTurn: room.currentTurn,
      });

      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(tickPayload);
      }
      if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
        room.guestWs.send(tickPayload);
      }

      // Sécurité anti-temps mort absolue : Le bot virtuel ne doit JAMAIS laisser couler le chrono
      // Si après 2 secondes (timerSec <= 28), le bot n'a pas encore joué, forcer l'exécution immédiate
      if (room.isBotMatch && room.currentTurn === room.botColor && !room.gameOver) {
        if (room.timerSec <= 28) {
          executeBotMoveNow(room);
        }
      }

      // Condition STRICTE : Lorsque le compteur atteint physiquement 0 seconde, arbitrage autoritaire instantané
      if (room.timerSec <= 0) {
        if (room.turnId !== currentTurnId || room.currentTurn !== turnColor) {
          return;
        }
        handleAuthoritativeTimeout(room);
      }
    }, 1000);
  }

  wss.on('connection', (ws) => {
    clients.set(ws, {});

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // 🏓 Heartbeat Ping-Pong instantané
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t || Date.now() }));
          return;
        }

        let meta = clients.get(ws) || {};

        // 🔄 Maintien de session & Reconnexion transparente après micro-coupure (4G/Wi-Fi)
        if (msg.type === 'RECONNECT_SESSION') {
          const roomId = msg.roomId || meta.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room) {
            const role = msg.role || meta.role;
            const isHost = role === 'host' || (room.hostMeta && room.hostMeta.playerId === msg.playerId);
            const clientRole: 'host' | 'guest' = isHost ? 'host' : 'guest';

            if (clientRole === 'host') {
              room.hostWs = ws;
              if (room.hostMeta) {
                meta = { ...room.hostMeta, roomId };
              }
            } else {
              room.guestWs = ws;
              if (room.guestMeta) {
                meta = { ...room.guestMeta, roomId };
              }
            }
            clients.set(ws, meta);

            // Annuler immédiatement le délai de grâce / buffer de déconnexion
            if (room.disconnectTimeout) {
              clearTimeout(room.disconnectTimeout);
              room.disconnectTimeout = null;
            }
            if (room.disconnectInterval) {
              clearInterval(room.disconnectInterval);
              room.disconnectInterval = null;
            }
            room.isPausedForReconnect = false;

            // Informer l'autre joueur du rétablissement immédiat de son adversaire
            const otherWs = clientRole === 'host' ? room.guestWs : room.hostWs;
            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'OPPONENT_RECONNECTED',
                message: "L'adversaire s'est reconnecté ! Reprise de la partie.",
              }));
            }

            // Reprendre le minuteur du tour s'il était suspendu
            if (room.gameStarted && !room.gameOver) {
              startRoomTimer(room);
            }

            // Renvoyer l'état officiel complet et certifié au joueur reconnecté
            ws.send(JSON.stringify({
              type: 'RECONNECT_SUCCESS',
              roomId: room.id,
              role: clientRole,
              myColor: meta.color,
              opponentColor: meta.color === 'green' ? 'red' : 'green',
              opponentName: clientRole === 'host' ? (room.isBotMatch ? room.botProfile?.name : room.guestMeta?.playerName) : room.hostMeta?.playerName,
              opponentAvatar: clientRole === 'host' ? (room.isBotMatch ? room.botProfile?.avatar : room.guestMeta?.avatar) : room.hostMeta?.avatar,
              opponentPhoto: clientRole === 'host' ? (room.isBotMatch ? undefined : room.guestMeta?.customPhoto) : room.hostMeta?.customPhoto,
              opponentFlag: clientRole === 'host' ? (room.isBotMatch ? room.botProfile?.flag : room.guestMeta?.flag) : room.hostMeta?.flag,
              opponentCountry: clientRole === 'host' ? (room.isBotMatch ? room.botProfile?.country : undefined) : undefined,
              opponentRating: clientRole === 'host' ? (room.isBotMatch ? room.botProfile?.rating : undefined) : undefined,
              opponentLevel: clientRole === 'host' ? (room.isBotMatch ? room.botProfile?.level : undefined) : undefined,
              isBotMatch: room.isBotMatch,
              board: room.board,
              currentTurn: room.currentTurn,
              turnId: room.turnId,
              timerSec: room.timerSec,
              gameStarted: room.gameStarted,
              gameOver: room.gameOver,
            }));

            // Si c'est au tour du bot virtuel, s'assurer que son coup s'exécute
            if (room.isBotMatch && room.currentTurn === room.botColor && !room.gameOver) {
              scheduleBotTurn(room);
            }
            return;
          } else {
            ws.send(JSON.stringify({
              type: 'RECONNECT_FAILED',
              message: 'La session demandée est expirée ou terminée.',
            }));
            return;
          }
        }

        if (msg.type === 'check_turn_timeout') {
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room && !room.gameOver) {
            if (room.isBotMatch && room.currentTurn === room.botColor) {
              executeBotMoveNow(room);
            } else if (!room.isBotMatch && room.timerSec <= 0) {
              handleAuthoritativeTimeout(room);
            }
          }
          return;
        }

        if (msg.type === 'turn_timeout') {
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room && !room.gameOver && room.timerSec <= 0) {
            handleAuthoritativeTimeout(room);
          }
          return;
        }

        const incomingRoomId = meta.roomId || msg.roomId;
        if (incomingRoomId) {
          const room = rooms.get(incomingRoomId);
          if (room) {
            const wasPaused = room.isPausedForReconnect;
            if (room.disconnectTimeout) {
              clearTimeout(room.disconnectTimeout);
              room.disconnectTimeout = null;
            }
            if (room.disconnectInterval) {
              clearInterval(room.disconnectInterval);
              room.disconnectInterval = null;
            }
            room.isPausedForReconnect = false;
            if (meta.role === 'host' || ws === room.hostWs) {
              room.hostWs = ws;
            } else if (meta.role === 'guest' || ws === room.guestWs) {
              room.guestWs = ws;
            }
            if (wasPaused) {
              const otherWs = ws === room.hostWs ? room.guestWs : room.hostWs;
              if (otherWs && otherWs.readyState === WebSocket.OPEN) {
                otherWs.send(JSON.stringify({
                  type: 'OPPONENT_RECONNECTED',
                  event: 'OPPONENT_RECONNECTED',
                  message: "L'adversaire s'est reconnecté ! Reprise de la partie.",
                }));
              }
              if (room.gameStarted && !room.gameOver) {
                startRoomTimer(room);
              }
            }
          }
        }

        if (msg.type === 'search_match' || msg.type === 'find_match') {
          const playerId = msg.playerId || `p_${Date.now()}`;
          const playerName = msg.playerName || 'Joueur';
          const region = msg.region || 'closest';
          const preferredColor: 'green' | 'red' | 'random' = msg.preferredColor || 'random';

          // Clean up any stale waiting player
          if (waitingPlayer && (waitingPlayer.ws.readyState !== WebSocket.OPEN || waitingPlayer.ws === ws)) {
            if (waitingPlayer.botTimer) {
              clearTimeout(waitingPlayer.botTimer);
              waitingPlayer.botTimer = null;
            }
            waitingPlayer = null;
          }

          if (!waitingPlayer) {
            // Premier appareil en recherche
            const playerEntry = {
              ws,
              playerId,
              playerName,
              avatar: msg.avatar || '👑',
              customPhoto: msg.customPhoto,
              flag: msg.flag,
              region,
              preferredColor,
              botTimer: null as NodeJS.Timeout | null,
            };
            waitingPlayer = playerEntry;

            ws.send(JSON.stringify({
              type: 'MATCHMAKING_WAITING',
              message: 'Recherche d’un adversaire en cours...',
            }));

            // Délai réaliste de recherche radar (2.4s à 3.4s) avant association avec l'un des 1 000 profils virtuels
            playerEntry.botTimer = setTimeout(() => {
              if (waitingPlayer && waitingPlayer.ws === ws && ws.readyState === WebSocket.OPEN) {
                const p1 = waitingPlayer;
                waitingPlayer = null;
                startBotMatch(p1);
              }
            }, 2400 + Math.floor(Math.random() * 1000));
          } else {
            // Second appareil connecté : Annule immédiatement le botTimer et associe les 2 joueurs réels
            if (waitingPlayer.botTimer) {
              clearTimeout(waitingPlayer.botTimer);
              waitingPlayer.botTimer = null;
            }
            const p1 = waitingPlayer;
            const p2 = {
              ws,
              playerId,
              playerName,
              avatar: msg.avatar || '👑',
              customPhoto: msg.customPhoto,
              flag: msg.flag,
              region,
              preferredColor,
            };
            waitingPlayer = null;

            const roomId = `online_match_${Date.now()}`;
            // 🎯 RÈGLE STRICTEMENT ALÉATOIRE : La couleur qui démarre est tirée au sort (50% Verts / 50% Rouges)
            const startingTurn: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';

            // 🎯 ATTRIBUTION STRICTEMENT ALÉATOIRE DES COULEURS EN LIGNE (50% Verts / 50% Rouges)
            const p1Color: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';
            const p2Color: 'green' | 'red' = p1Color === 'green' ? 'red' : 'green';

            const hostMeta: ClientMeta = {
              roomId,
              role: 'host',
              playerId: p1.playerId,
              playerName: p1.playerName,
              avatar: p1.avatar,
              customPhoto: p1.customPhoto,
              flag: p1.flag,
              color: p1Color,
            };
            const guestMeta: ClientMeta = {
              roomId,
              role: 'guest',
              playerId: p2.playerId,
              playerName: p2.playerName,
              avatar: p2.avatar,
              customPhoto: p2.customPhoto,
              flag: p2.flag,
              color: p2Color,
            };

            const initialBoard = getInitialBoardState();

            const room: RoomState = {
              id: roomId,
              hostWs: p1.ws,
              guestWs: p2.ws,
              hostMeta,
              guestMeta,
              board: initialBoard,
              currentTurn: startingTurn,
              gameStarted: true,
              gameOver: false,
              movesWithoutCapture: 0,
              rematchRequestedBy: undefined,
              timerSec: 30,
              timerInterval: null,
              watchdogTimeout: null,
              disconnectTimeout: null,
              turnId: 0,
              consecutiveTimeouts: { green: 0, red: 0 },
              isBotMatch: false,
            };

            rooms.set(roomId, room);
            clients.set(p1.ws, hostMeta);
            clients.set(p2.ws, guestMeta);

            // Joueur 1 (Hôte)
            p1.ws.send(JSON.stringify({
              type: 'MATCH_FOUND',
              roomId,
              role: 'host',
              myColor: p1Color,
              opponentColor: p2Color,
              startingTurn,
              currentTurn: startingTurn,
              opponentName: p2.playerName,
              opponentAvatar: p2.avatar,
              opponentPhoto: p2.customPhoto,
              isBotMatch: false,
              message: `Adversaire trouvé ! Vous jouez les Pions ${p1Color === 'green' ? 'Verts' : 'Rouges'}.`,
            }));

            // Joueur 2 (Invité)
            p2.ws.send(JSON.stringify({
              type: 'MATCH_FOUND',
              roomId,
              role: 'guest',
              myColor: p2Color,
              opponentColor: p1Color,
              startingTurn,
              currentTurn: startingTurn,
              opponentName: p1.playerName,
              opponentAvatar: p1.avatar,
              opponentPhoto: p1.customPhoto,
              isBotMatch: false,
              message: `Adversaire trouvé ! Vous jouez les Pions ${p2Color === 'green' ? 'Verts' : 'Rouges'}.`,
            }));

            // Payload complet et ciblé pour le Joueur 1 (Hôte)
            const hostStartPayload = JSON.stringify({
              type: 'START_MATCH',
              event: 'START_MATCH',
              board: initialBoard,
              startingTurn,
              currentTurn: startingTurn,
              turn: startingTurn,
              role: 'host',
              myColor: p1Color,
              opponentColor: p2Color,
              hostColor: p1Color,
              guestColor: p2Color,
              playerName: p1.playerName,
              opponentName: p2.playerName,
              opponentAvatar: p2.avatar,
              opponentPhoto: p2.customPhoto,
              roomId,
              movesWithoutCapture: 0,
              isBotMatch: false,
              payload: {
                role: 'host',
                myColor: p1Color,
                opponentColor: p2Color,
                hostColor: p1Color,
                guestColor: p2Color,
                playerName: p1.playerName,
                opponentName: p2.playerName,
                opponentAvatar: p2.avatar,
                opponentPhoto: p2.customPhoto,
                startingTurn,
                currentTurn: startingTurn,
                board: initialBoard,
                turn: startingTurn,
                roomId,
                movesWithoutCapture: 0,
                isBotMatch: false,
              },
            });

            // Payload complet et ciblé pour le Joueur 2 (Invité)
            const guestStartPayload = JSON.stringify({
              type: 'START_MATCH',
              event: 'START_MATCH',
              board: initialBoard,
              startingTurn,
              currentTurn: startingTurn,
              turn: startingTurn,
              role: 'guest',
              myColor: p2Color,
              opponentColor: p1Color,
              hostColor: p1Color,
              guestColor: p2Color,
              playerName: p2.playerName,
              opponentName: p1.playerName,
              opponentAvatar: p1.avatar,
              opponentPhoto: p1.customPhoto,
              roomId,
              movesWithoutCapture: 0,
              isBotMatch: false,
              payload: {
                role: 'guest',
                myColor: p2Color,
                opponentColor: p1Color,
                hostColor: p1Color,
                guestColor: p2Color,
                playerName: p2.playerName,
                opponentName: p1.playerName,
                opponentAvatar: p1.avatar,
                opponentPhoto: p1.customPhoto,
                startingTurn,
                currentTurn: startingTurn,
                board: initialBoard,
                turn: startingTurn,
                roomId,
                movesWithoutCapture: 0,
              },
            });

            if (p1.ws.readyState === WebSocket.OPEN) {
              p1.ws.send(hostStartPayload);
            }
            if (p2.ws.readyState === WebSocket.OPEN) {
              p2.ws.send(guestStartPayload);
            }

            startRoomTimer(room);
          }
        } else if (msg.type === 'cancel_match' || msg.type === 'cancel_search') {
          if (waitingPlayer && waitingPlayer.ws === ws) {
            if (waitingPlayer.botTimer) {
              clearTimeout(waitingPlayer.botTimer);
              waitingPlayer.botTimer = null;
            }
            waitingPlayer = null;
          }
          ws.send(JSON.stringify({
            type: 'MATCHMAKING_CANCELLED',
            message: 'Recherche annulée.',
          }));
        } else if (msg.type === 'create_room') {
          const roomId = String(msg.roomId || Math.floor(100000 + Math.random() * 900000)).toUpperCase().trim();
          const playerId = msg.playerId || `p_${Date.now()}`;
          const playerName = msg.playerName || 'Hôte';

          // 🎯 CHOIX DE COULEUR AU PRÉALABLE PAR L'HÔTE
          const pref = msg.preferredColor || msg.hostColor || msg.color || 'green';
          let chosenColor: 'green' | 'red' = 'green';
          if (pref === 'red') {
            chosenColor = 'red';
          } else if (pref === 'random') {
            chosenColor = Math.random() < 0.5 ? 'green' : 'red';
          } else {
            chosenColor = 'green';
          }

          meta.roomId = roomId;
          meta.role = 'host';
          meta.playerId = playerId;
          meta.playerName = playerName;
          meta.avatar = msg.avatar || '👑';
          meta.customPhoto = msg.customPhoto;
          meta.flag = msg.flag;
          meta.color = chosenColor;
          clients.set(ws, meta);

          let room = rooms.get(roomId);
          if (!room) {
            room = {
              id: roomId,
              hostWs: ws,
              guestWs: null,
              hostMeta: meta,
              guestMeta: null,
              board: getInitialBoardState(),
              currentTurn: 'green',
              gameStarted: false,
              gameOver: false,
              movesWithoutCapture: 0,
              rematchRequestedBy: undefined,
              timerSec: 30,
              timerInterval: null,
              watchdogTimeout: null,
              disconnectTimeout: null,
              turnId: 0,
              consecutiveTimeouts: { green: 0, red: 0 },
            };
            rooms.set(roomId, room);
          } else {
            room.hostWs = ws;
            room.hostMeta = meta;
          }

          ws.send(JSON.stringify({
            type: 'ROOM_CREATED',
            event: 'ROOM_CREATED',
            roomId,
            code: roomId,
            role: 'host',
            myColor: chosenColor,
            message: `Salle #${roomId} créée avec succès ! Pions ${chosenColor === 'green' ? 'Verts' : 'Rouges'}.`,
          }));
        } else if (msg.type === 'join_room') {
          const roomId = String(msg.roomId).toUpperCase().trim();
          const role: 'host' | 'guest' = msg.role === 'host' ? 'host' : 'guest';
          const playerId = msg.playerId || `p_${Date.now()}`;
          const playerName = msg.playerName || (role === 'host' ? 'Hôte' : 'Invité');

          meta.roomId = roomId;
          meta.role = role;
          meta.playerId = playerId;
          meta.playerName = playerName;
          meta.avatar = msg.avatar || '👑';
          meta.customPhoto = msg.customPhoto;
          meta.flag = msg.flag;
          clients.set(ws, meta);

          if (role === 'guest') {
            // Contrôle strict du code de salon (Mode VS Amis) :
            // Si l'invité saisit un code incorrect, affiche l'alerte et ne lance pas le jeu.
            const room = rooms.get(roomId);
            if (!room || !room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'JOIN_ERROR',
                errorCode: 'INVALID_ROOM_CODE',
                message: 'Code incorrect. Veuillez recontrôler le code.',
              }));
              return;
            }

            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN && room.guestWs !== ws) {
              ws.send(JSON.stringify({
                type: 'JOIN_ERROR',
                errorCode: 'ROOM_FULL',
                message: 'Ce salon est déjà complet (2 joueurs maximum).',
              }));
              return;
            }

            room.guestWs = ws;
            const hostColor = room.hostMeta?.color || 'green';
            const guestColor: 'green' | 'red' = hostColor === 'green' ? 'red' : 'green';
            meta.color = guestColor;
            room.guestMeta = meta;

            // 🎯 RÈGLE ALÉATOIRE DANS TOUS LES MODES : Premier tour tiré au sort (50% Verts / 50% Rouges)
            const startingTurn: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';
            const initialBoard = getInitialBoardState();
            room.board = initialBoard;
            room.gameStarted = true;
            room.gameOver = false;
            room.winner = undefined;
            room.movesWithoutCapture = 0;
            room.rematchRequestedBy = undefined;
            room.currentTurn = startingTurn;

            // Confirmation exacte de la validation du code
            ws.send(JSON.stringify({
              type: 'JOIN_SUCCESS',
              roomId,
              message: 'Code validé avec succès ! Salon rejoint.',
            }));

            ws.send(JSON.stringify({
              type: 'ASSIGN_ROLE',
              role: 'guest',
              myColor: guestColor,
              opponentColor: hostColor,
              opponentName: room.hostMeta?.playerName || 'Hôte',
              opponentAvatar: room.hostMeta?.avatar || '👑',
              opponentPhoto: room.hostMeta?.customPhoto,
              startingTurn,
              roomId,
              message: `Vous êtes l’Invité (${guestColor === 'green' ? 'Verts' : 'Rouges'}).`,
            }));

            ws.send(JSON.stringify({
              type: 'room_joined',
              roomId,
              role: 'guest',
              clientsCount: 2,
            }));

            // Notify host that guest connected
            room.hostWs.send(JSON.stringify({
              type: 'player_joined',
              role: 'guest',
              color: guestColor,
              opponentName: meta.playerName || 'Invité',
              opponentAvatar: meta.avatar || '👑',
              opponentPhoto: meta.customPhoto,
              message: 'Votre ami a rejoint la salle !',
            }));

            // DÉMARRAGE IMMÉDIAT ET AUTOMATIQUE (Mode VS Amis) :
            // Payload ciblé pour l'Hôte
            const hostStartPayload = JSON.stringify({
              type: 'START_MATCH',
              event: 'START_MATCH',
              board: initialBoard,
              turn: startingTurn.toUpperCase(),
              startingTurn,
              currentTurn: startingTurn,
              role: 'host',
              myColor: hostColor,
              opponentColor: guestColor,
              hostColor,
              guestColor,
              playerName: room.hostMeta?.playerName || 'Hôte',
              opponentName: meta.playerName || 'Ami',
              opponentAvatar: meta.avatar || '👑',
              opponentPhoto: meta.customPhoto,
              roomId,
              movesWithoutCapture: 0,
              isBotMatch: false,
              payload: {
                role: 'host',
                myColor: hostColor,
                opponentColor: guestColor,
                hostColor,
                guestColor,
                playerName: room.hostMeta?.playerName || 'Hôte',
                opponentName: meta.playerName || 'Ami',
                opponentAvatar: meta.avatar || '👑',
                opponentPhoto: meta.customPhoto,
                startingTurn,
                currentTurn: startingTurn,
                board: initialBoard,
                turn: startingTurn.toUpperCase(),
                roomId,
                movesWithoutCapture: 0,
                isBotMatch: false,
              },
            });

            // Payload ciblé pour l'Invité
            const guestStartPayload = JSON.stringify({
              type: 'START_MATCH',
              event: 'START_MATCH',
              board: initialBoard,
              turn: startingTurn.toUpperCase(),
              startingTurn,
              currentTurn: startingTurn,
              role: 'guest',
              myColor: guestColor,
              opponentColor: hostColor,
              hostColor,
              guestColor,
              playerName: meta.playerName || 'Invité',
              opponentName: room.hostMeta?.playerName || 'Hôte',
              opponentAvatar: room.hostMeta?.avatar || '👑',
              opponentPhoto: room.hostMeta?.customPhoto,
              roomId,
              movesWithoutCapture: 0,
              isBotMatch: false,
              payload: {
                role: 'guest',
                myColor: guestColor,
                opponentColor: hostColor,
                hostColor,
                guestColor,
                playerName: meta.playerName || 'Invité',
                opponentName: room.hostMeta?.playerName || 'Hôte',
                opponentAvatar: room.hostMeta?.avatar || '👑',
                opponentPhoto: room.hostMeta?.customPhoto,
                startingTurn,
                currentTurn: startingTurn,
                board: initialBoard,
                turn: startingTurn.toUpperCase(),
                roomId,
                movesWithoutCapture: 0,
                isBotMatch: false,
              },
            });

            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(hostStartPayload);
            }
            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
              room.guestWs.send(guestStartPayload);
            }

            startRoomTimer(room);
          } else {
            // Role === 'host' : Hôte = GREEN par défaut
            let room = rooms.get(roomId);
            if (!room) {
              room = {
                id: roomId,
                hostWs: ws,
                guestWs: null,
                hostMeta: meta,
                guestMeta: null,
                board: getInitialBoardState(),
                currentTurn: 'green',
                gameStarted: false,
                gameOver: false,
                movesWithoutCapture: 0,
                rematchRequestedBy: undefined,
                timerSec: 30,
                timerInterval: null,
                watchdogTimeout: null,
                disconnectTimeout: null,
                turnId: 0,
                consecutiveTimeouts: { green: 0, red: 0 },
              };
              rooms.set(roomId, room);
            } else {
              room.hostWs = ws;
              room.hostMeta = meta;
            }

            const chosenColor: 'green' | 'red' = 'green';
            meta.color = chosenColor;
            room.hostMeta = meta;
            const oppColor: 'green' | 'red' = 'red';

            ws.send(JSON.stringify({
              type: 'ASSIGN_ROLE',
              role: 'host',
              myColor: chosenColor,
              opponentColor: oppColor,
              startingTurn: 'green',
              roomId,
              message: 'Vous êtes l’Hôte (Pions Verts).',
            }));

            ws.send(JSON.stringify({
              type: 'room_joined',
              roomId,
              role: 'host',
              clientsCount: room.guestWs ? 2 : 1,
            }));
          }

          // If both host and guest are in the room, host can start or start can be triggered
          const currentRoom = rooms.get(roomId);
          if (currentRoom?.hostWs && currentRoom?.guestWs && msg.autoStart) {
            currentRoom.gameStarted = true;
            const randomStartingTurn: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';
            currentRoom.currentTurn = randomStartingTurn;

            const hostColor = currentRoom.hostMeta?.color || 'green';
            const guestColor: 'green' | 'red' = hostColor === 'green' ? 'red' : 'green';

            const gameStartPayload = {
              type: 'start_game',
              payload: {
                hostColor,
                guestColor,
                startingTurn: randomStartingTurn,
                currentTurn: randomStartingTurn,
                roomId,
              },
            };

            const startPayloadStr = JSON.stringify(gameStartPayload);
            if (currentRoom.hostWs.readyState === WebSocket.OPEN) {
              currentRoom.hostWs.send(startPayloadStr);
            }
            if (currentRoom.guestWs.readyState === WebSocket.OPEN) {
              currentRoom.guestWs.send(startPayloadStr);
            }

            startRoomTimer(currentRoom);
          }
        } else if (msg.type === 'chain_step') {
          // Étape intermédiaire d'une multi-capture : le tour reste au même joueur !
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room) {
            startRoomTimer(room); // Réinitialise complètement le timer pour la multi-capture
            const otherWs = ws === room.hostWs ? room.guestWs : room.hostWs;
            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'chain_step',
                event: 'chain_step',
                payload: msg.payload || msg,
                currentTurn: room.currentTurn,
                turn: room.currentTurn,
                nextTurn: room.currentTurn,
                timerSec: 30,
              }));
            }
          }
        } else if (msg.type === 'PLAYER_STUCK' || msg.type === 'NO_VALID_MOVES') {
          // 🛑 FIN DE PARTIE SYNCHRONE : Un joueur n'a plus aucun coup légal valide (pions bloqués)
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room && !room.gameOver) {
            const stuckColor: 'green' | 'red' = (msg.stuckColor || msg.payload?.stuckColor || (msg.loser === 'green' ? 'green' : 'red')) as 'green' | 'red';
            const winner: 'green' | 'red' = (msg.winner || msg.payload?.winner || (stuckColor === 'green' ? 'red' : 'green')) as 'green' | 'red';
            room.gameOver = true;
            room.winner = winner;
            room.gameOverReason = 'blocked';
            stopRoomTimer(room);

            const stuckBroadcast = JSON.stringify({
              type: 'PLAYER_STUCK',
              event: 'PLAYER_STUCK',
              roomId: room.id,
              stuckColor,
              loser: stuckColor,
              winner,
              gameOver: true,
              gameOverReason: 'blocked',
              message: msg.message || `Fin de partie : Les ${stuckColor === 'green' ? 'Verts' : 'Rouges'} n'ont plus aucun coup valide. Victoire des ${winner === 'green' ? 'Verts' : 'Rouges'} !`,
            });

            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(stuckBroadcast);
            }
            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
              room.guestWs.send(stuckBroadcast);
            }
          }
        } else if (msg.type === 'MOVE_PIECE' || msg.type === 'make_move') {
          // 🛡️ SERVEUR AUTORITAIRE UNIQUE : Validation stricte et arbitrage de chaque coup
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;

          if (room) {
            if (room.gameOver) return;

            const isHost = ws === room.hostWs;
            const playerColor: 'green' | 'red' = (
              meta.color ||
              (isHost ? room.hostMeta?.color : room.guestMeta?.color) ||
              msg.movingColor ||
              msg.payload?.movingColor ||
              'green'
            ) as 'green' | 'red';

            const isChain = Boolean(msg.isChainStep || msg.payload?.isChainStep);

            // Validation de tour stricte : seul le joueur dont c'est le tour peut jouer
            if (room.currentTurn !== playerColor && !isChain) {
              console.warn(`[MOVE_REJECTED] Coup refusé pour ${playerColor}: c'est le tour des ${room.currentTurn}`);
              // Recaler le client en retard sur l'état officiel sans le bloquer
              ws.send(JSON.stringify({
                type: 'GAME_STATE_UPDATE',
                board: room.board,
                currentTurn: room.currentTurn,
                turn: room.currentTurn,
                timerSec: room.timerSec,
                turnId: room.turnId,
              }));
              return;
            }

            // Mise à jour officielle de l'échiquier sur le serveur
            const incomingBoard = msg.board || msg.payload?.board;
            if (incomingBoard && Array.isArray(incomingBoard) && incomingBoard.length === 5) {
              room.board = incomingBoard;
            }

            const rawNext = msg.nextTurn || msg.payload?.nextTurn;
            const nextTurn: 'green' | 'red' = isChain
              ? room.currentTurn
              : ((rawNext === 'green' || rawNext === 'red')
                ? rawNext
                : (room.currentTurn === 'green' ? 'red' : 'green'));

            room.currentTurn = nextTurn;
            room.turnId = (room.turnId || 0) + 1;

            const isAuto = Boolean(msg.isAutoMove || msg.payload?.isAutoMove);
            if (!isAuto && room.consecutiveTimeouts) {
              room.consecutiveTimeouts[playerColor] = 0;
            }

            const payloadObj = msg.payload || {};
            const lastMoveData = msg.lastMove || payloadObj.lastMove || (
              (payloadObj.fr !== undefined && payloadObj.tr !== undefined)
                ? {
                    fr: payloadObj.fr,
                    fc: payloadObj.fc,
                    tr: payloadObj.tr,
                    tc: payloadObj.tc,
                    isCap: Boolean(payloadObj.isCap),
                  }
                : (msg.fr !== undefined && msg.tr !== undefined)
                ? {
                    fr: msg.fr,
                    fc: msg.fc,
                    tr: msg.tr,
                    tc: msg.tc,
                    isCap: Boolean(msg.isCap),
                  }
                : null
            );
            const wasPenalty = Boolean(msg.wasPenalty || payloadObj.wasPenalty);
            const punishedCoords = msg.punishedCoords || payloadObj.punishedCoords;

            // ⚖️ RÈGLE DES 50 COUPS SANS PRISE (En Ligne & Amis) :
            // Si le coup comporte une capture ou une punition, réinitialiser à 0.
            // Sinon, incrémenter de 1 à chaque coup simple terminé (hors étapes intermédiaires de multi-capture).
            const isCap = Boolean(lastMoveData?.isCap || (isChain && lastMoveData));
            if (isCap || wasPenalty) {
              room.movesWithoutCapture = 0;
            } else if (!isChain) {
              room.movesWithoutCapture = (room.movesWithoutCapture || 0) + 1;
            }

            // Vérification stricte des conditions de fin de match
            const counts = countPiecesOnBoard(room.board);
            let gameOverReason: string | undefined = undefined;

            if (counts.green === 0 && counts.red > 0) {
              room.gameOver = true;
              room.winner = 'red';
              room.gameOverReason = 'elimination';
              gameOverReason = 'elimination';
              room.rematchRequestedBy = undefined;
              stopRoomTimer(room);
            } else if (counts.red === 0 && counts.green > 0) {
              room.gameOver = true;
              room.winner = 'green';
              room.gameOverReason = 'elimination';
              gameOverReason = 'elimination';
              room.rematchRequestedBy = undefined;
              stopRoomTimer(room);
            } else if (
              counts.green === 1 &&
              counts.red === 1 &&
              !hasCaptureMoves(room.board, 'green') &&
              !hasCaptureMoves(room.board, 'red')
            ) {
              // ⚖️ RÈGLE OFFICIELLE DU MATCH NUL : 1 pion restant de chaque côté sans capture immédiate possible
              room.gameOver = true;
              room.winner = 'draw';
              room.gameOverReason = 'draw_1v1';
              gameOverReason = 'draw_1v1';
              room.rematchRequestedBy = undefined;
              stopRoomTimer(room);
            } else if (!hasLegalMoves(room.board, nextTurn)) {
              // 🛑 BLOCAGE COMPLET SYNCHRONE : Le joueur suivant n'a plus aucun coup légal
              // Défaite immédiate pour le joueur bloqué, Victoire pour l'adversaire
              room.gameOver = true;
              room.winner = nextTurn === 'green' ? 'red' : 'green';
              room.gameOverReason = 'blocked';
              gameOverReason = 'blocked';
              room.rematchRequestedBy = undefined;
              stopRoomTimer(room);
            } else if (room.movesWithoutCapture >= 50) {
              // ⚖️ RÈGLE DES 50 COUPS SANS PRISE : Victoire au nombre de pions restants (ou Nul si égalité stricte)
              room.gameOver = true;
              const res50 = resolve50MovesWinner(room.board);
              room.winner = res50.winner;
              room.gameOverReason = 'draw_50_moves';
              gameOverReason = 'draw_50_moves';
              room.rematchRequestedBy = undefined;
              stopRoomTimer(room);
            } else {
              startRoomTimer(room);
            }

            const senderPlayerId = meta.playerId || msg.playerId || payloadObj.playerId;

            // 🎯 DIFFUSION SYNCHRONE DE L'ÉTAT DU JEU AUX DEUX CLIENTS EN MÊME TEMPS
            // Aucun client ne gère l'alternance de son côté : l'état du serveur fait foi absolue.
            const stateUpdatePayload = JSON.stringify({
              type: 'GAME_STATE_UPDATE',
              event: 'GAME_STATE_UPDATE',
              board: room.board,
              currentTurn: room.currentTurn,
              turn: room.currentTurn,
              nextTurn: room.currentTurn,
              turnId: room.turnId,
              lastMove: lastMoveData,
              fr: lastMoveData?.fr,
              fc: lastMoveData?.fc,
              tr: lastMoveData?.tr,
              tc: lastMoveData?.tc,
              isCap: Boolean(lastMoveData?.isCap),
              wasPenalty,
              punishedCoords,
              isChainStep: isChain,
              movingColor: playerColor,
              senderPlayerId,
              playerId: senderPlayerId,
              timerSec: 30,
              movesWithoutCapture: room.movesWithoutCapture || 0,
              gameOver: room.gameOver,
              winner: room.winner,
              gameOverReason,
              isBotMatch: Boolean(room.isBotMatch),
            });

            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(stateUpdatePayload);
            }
            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
              room.guestWs.send(stateUpdatePayload);
            }

            // Compatibilité avec les animations et SFX
            const movePiecePayload = JSON.stringify({
              type: 'MOVE_PIECE',
              event: 'MOVE_PIECE',
              board: room.board,
              lastMove: lastMoveData,
              fr: lastMoveData?.fr,
              fc: lastMoveData?.fc,
              tr: lastMoveData?.tr,
              tc: lastMoveData?.tc,
              isCap: Boolean(lastMoveData?.isCap),
              nextTurn: room.currentTurn,
              turn: room.currentTurn,
              currentTurn: room.currentTurn,
              isChainStep: isChain,
              wasPenalty,
              punishedCoords,
              movingColor: playerColor,
              senderPlayerId,
              playerId: senderPlayerId,
              timerSec: 30,
              movesWithoutCapture: room.movesWithoutCapture || 0,
              gameOver: room.gameOver,
              winner: room.winner,
              gameOverReason,
            });

            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(movePiecePayload);
              if (room.gameOver) {
                room.hostWs.send(JSON.stringify({
                  type: 'GAME_OVER',
                  event: 'GAME_OVER',
                  roomId: room.id,
                  gameOver: true,
                  winner: room.winner,
                  gameOverReason: room.gameOverReason || gameOverReason,
                  movesWithoutCapture: room.movesWithoutCapture,
                  message: room.winner === 'draw'
                    ? '⚖️ Règle des 50 coups sans prise atteinte : Match Nul !'
                    : `Victoire des ${room.winner === 'green' ? 'Verts' : 'Rouges'} !`,
                }));
              }
            }
            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
              room.guestWs.send(movePiecePayload);
              if (room.gameOver) {
                room.guestWs.send(JSON.stringify({
                  type: 'GAME_OVER',
                  event: 'GAME_OVER',
                  roomId: room.id,
                  gameOver: true,
                  winner: room.winner,
                  gameOverReason: room.gameOverReason || gameOverReason,
                  movesWithoutCapture: room.movesWithoutCapture,
                  message: room.winner === 'draw'
                    ? '⚖️ Règle des 50 coups sans prise atteinte : Match Nul !'
                    : `Victoire des ${room.winner === 'green' ? 'Verts' : 'Rouges'} !`,
                }));
              }
            }

            // Si partie avec profil virtuel (bot) et c'est au tour du bot de jouer
            if (room.isBotMatch && room.currentTurn === room.botColor && !room.gameOver && !isChain) {
              scheduleBotTurn(room);
            }
          }
        } else if (msg.type === 'claim_draw_50' || msg.type === 'game_over_draw_50') {
          // ⚖️ RÉCLAMATION SYNCHRONE DU VERDICT DES 50 COUPS SANS PRISE
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room && !room.gameOver) {
            room.gameOver = true;
            const res50 = resolve50MovesWinner(room.board);
            room.winner = res50.winner;
            room.gameOverReason = 'draw_50_moves';
            room.movesWithoutCapture = 50;
            room.rematchRequestedBy = undefined;
            stopRoomTimer(room);

            const drawPayload = JSON.stringify({
              type: 'GAME_OVER',
              event: 'GAME_OVER',
              roomId: room.id,
              gameOver: true,
              winner: res50.winner,
              greenCount: res50.greenCount,
              redCount: res50.redCount,
              gameOverReason: 'draw_50_moves',
              movesWithoutCapture: 50,
              message: res50.message,
            });
            const statePayload = JSON.stringify({
              type: 'GAME_STATE_UPDATE',
              event: 'GAME_STATE_UPDATE',
              board: room.board,
              currentTurn: room.currentTurn,
              turn: room.currentTurn,
              nextTurn: room.currentTurn,
              turnId: room.turnId,
              timerSec: 30,
              movesWithoutCapture: 50,
              gameOver: true,
              winner: res50.winner,
              gameOverReason: 'draw_50_moves',
              message: res50.message,
            });

            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(drawPayload);
              room.hostWs.send(statePayload);
            }
            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
              room.guestWs.send(drawPayload);
              room.guestWs.send(statePayload);
            }
          }
        } else if (msg.type === 'request_rematch') {
          // ⚔️ GESTION OFFICIELLE DU REMATCH (DEMANDE DE REVANCHE)
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room) {
            if (room.isBotMatch) {
              ws.send(JSON.stringify({
                type: 'REMATCH_PENDING',
                message: "Demande de revanche envoyée... En attente de l'adversaire.",
              }));
              setTimeout(() => {
                if (!rooms.has(room.id)) return;
                stopRoomTimer(room);
                const freshBoard = getInitialBoardState();
                room.board = freshBoard;
                room.gameOver = false;
                room.winner = undefined;
                room.gameOverReason = undefined;
                room.movesWithoutCapture = 0;
                room.rematchRequestedBy = undefined;
                room.turnId = 0;
                room.consecutiveTimeouts = { green: 0, red: 0 };
                room.timerSec = 30;

                const startingTurn: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';
                room.currentTurn = startingTurn;
                room.gameStarted = true;

                const hostColor = room.hostMeta?.color || 'green';
                const botColor = room.botColor || (hostColor === 'green' ? 'red' : 'green');

                const rematchStartHost = JSON.stringify({
                  type: 'START_MATCH',
                  event: 'START_MATCH',
                  board: freshBoard,
                  startingTurn,
                  currentTurn: startingTurn,
                  turn: startingTurn,
                  role: 'host',
                  myColor: hostColor,
                  opponentColor: botColor,
                  hostColor,
                  guestColor: botColor,
                  playerName: room.hostMeta?.playerName || 'Joueur',
                  opponentName: room.botProfile?.name || 'Adversaire',
                  opponentAvatar: room.botProfile?.avatar || '👑',
                  opponentPhoto: undefined,
                  opponentFlag: room.botProfile?.flag,
                  opponentCountry: room.botProfile?.country,
                  opponentLevel: room.botProfile?.level,
                  opponentRating: room.botProfile?.rating,
                  roomId: room.id,
                  movesWithoutCapture: 0,
                  isRematch: true,
                  payload: {
                    role: 'host',
                    myColor: hostColor,
                    opponentColor: botColor,
                    hostColor,
                    guestColor: botColor,
                    playerName: room.hostMeta?.playerName || 'Joueur',
                    opponentName: room.botProfile?.name || 'Adversaire',
                    opponentAvatar: room.botProfile?.avatar || '👑',
                    opponentPhoto: undefined,
                    opponentFlag: room.botProfile?.flag,
                    opponentCountry: room.botProfile?.country,
                    opponentLevel: room.botProfile?.level,
                    opponentRating: room.botProfile?.rating,
                    startingTurn,
                    currentTurn: startingTurn,
                    board: freshBoard,
                    turn: startingTurn,
                    roomId: room.id,
                    movesWithoutCapture: 0,
                    isRematch: true,
                  },
                });

                if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
                  room.hostWs.send(rematchStartHost);
                }
                startRoomTimer(room);
                if (startingTurn === botColor) {
                  scheduleBotTurn(room);
                }
              }, 1200);
              return;
            }

            const role = meta.role || (ws === room.hostWs ? 'host' : 'guest');
            room.rematchRequestedBy = role;
            const otherWs = role === 'host' ? room.guestWs : room.hostWs;
            const requesterName = (role === 'host' ? room.hostMeta?.playerName : room.guestMeta?.playerName) || 'L’adversaire';

            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'REMATCH_REQUESTED',
                requesterRole: role,
                requesterName,
                message: `${requesterName} demande une revanche !`,
              }));
            }
            ws.send(JSON.stringify({
              type: 'REMATCH_PENDING',
              message: "Demande de revanche envoyée... En attente de l'adversaire.",
            }));
          }
        } else if (msg.type === 'accept_rematch') {
          // ⚔️ REVANCHE ACCEPTÉE PAR LES DEUX : NOUVELLE GRILLE DE DÉPART VIERGE ET RÉINITIALISÉE
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room) {
            stopRoomTimer(room);
            const freshBoard = getInitialBoardState();
            room.board = freshBoard;
            room.gameOver = false;
            room.winner = undefined;
            room.gameOverReason = undefined;
            room.movesWithoutCapture = 0;
            room.rematchRequestedBy = undefined;
            room.turnId = 0;
            room.consecutiveTimeouts = { green: 0, red: 0 };
            room.timerSec = 30;

            // Tirage au sort aléatoire du premier coup (50% Verts / 50% Rouges)
            const startingTurn: 'green' | 'red' = Math.random() < 0.5 ? 'green' : 'red';
            room.currentTurn = startingTurn;
            room.gameStarted = true;

            const hostColor = room.hostMeta?.color || 'green';
            const guestColor = room.guestMeta?.color || 'red';

            const rematchStartHost = JSON.stringify({
              type: 'START_MATCH',
              event: 'START_MATCH',
              board: freshBoard,
              startingTurn,
              currentTurn: startingTurn,
              turn: startingTurn,
              role: 'host',
              myColor: hostColor,
              opponentColor: guestColor,
              hostColor,
              guestColor,
              playerName: room.hostMeta?.playerName || 'Hôte',
              opponentName: room.guestMeta?.playerName || 'Adversaire',
              opponentAvatar: room.guestMeta?.avatar || '👑',
              opponentPhoto: room.guestMeta?.customPhoto,
              roomId: room.id,
              movesWithoutCapture: 0,
              isRematch: true,
              isBotMatch: false,
            });

            const rematchStartGuest = JSON.stringify({
              type: 'START_MATCH',
              event: 'START_MATCH',
              board: freshBoard,
              startingTurn,
              currentTurn: startingTurn,
              turn: startingTurn,
              role: 'guest',
              myColor: guestColor,
              opponentColor: hostColor,
              hostColor,
              guestColor,
              playerName: room.guestMeta?.playerName || 'Invité',
              opponentName: room.hostMeta?.playerName || 'Adversaire',
              opponentAvatar: room.hostMeta?.avatar || '👑',
              opponentPhoto: room.hostMeta?.customPhoto,
              roomId: room.id,
              movesWithoutCapture: 0,
              isRematch: true,
              isBotMatch: false,
            });

            if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
              room.hostWs.send(rematchStartHost);
            }
            if (room.guestWs && room.guestWs.readyState === WebSocket.OPEN) {
              room.guestWs.send(rematchStartGuest);
            }

            startRoomTimer(room);
          }
        } else if (msg.type === 'decline_rematch') {
          // Revanche refusée : avertir le demandeur
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room) {
            room.rematchRequestedBy = undefined;
            const otherWs = ws === room.hostWs ? room.guestWs : room.hostWs;
            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'REMATCH_DECLINED',
                message: "L'adversaire a décliné la proposition de revanche.",
              }));
            }
          }
        } else if (msg.type === 'leave_room' || msg.type === 'surrender') {
          const roomId = meta.roomId || msg.roomId;
          const room = roomId ? rooms.get(roomId) : undefined;
          if (room) {
            stopRoomTimer(room);
            const isHost = ws === room.hostWs;
            const hostCol = room.hostMeta?.color || 'green';
            const guestCol = room.guestMeta?.color || (hostCol === 'green' ? 'red' : 'green');
            const loserColor: 'green' | 'red' = (msg.loser as 'green' | 'red') || (isHost ? hostCol : guestCol);
            const winnerColor: 'green' | 'red' = (msg.winner as 'green' | 'red') || (loserColor === 'green' ? 'red' : 'green');

            // Envoi de la confirmation d'abandon au joueur qui quitte
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'SELF_LEFT',
                reason: 'self_forfeit',
                winner: winnerColor,
                loser: loserColor,
                message: 'Défaite par forfait : Vous avez quitté la partie.',
              }));
            }

            const otherWs = isHost ? room.guestWs : room.hostWs;
            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              const opponentLeftPayload = JSON.stringify({
                type: 'OPPONENT_LEFT',
                event: 'OPPONENT_LEFT',
                reason: 'surrender_or_leave',
                winner: winnerColor,
                loser: loserColor,
                message: "L'adversaire a abandonné la partie.",
              });
              otherWs.send(opponentLeftPayload);
            }
            rooms.delete(roomId);
          }
        } else if (meta.roomId) {
          // Relayer les messages de divertissement (émojis, chat, réactions)
          const room = rooms.get(meta.roomId);
          if (room) {
            const outbound = JSON.stringify(msg);
            const otherWs = ws === room.hostWs ? room.guestWs : room.hostWs;
            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(outbound);
            }
          }
        }
      } catch (err) {
        console.error('WebSocket parse error:', err);
      }
    });

    ws.on('close', () => {
      if (waitingPlayer && waitingPlayer.ws === ws) {
        if (waitingPlayer.botTimer) {
          clearTimeout(waitingPlayer.botTimer);
          waitingPlayer.botTimer = null;
        }
        waitingPlayer = null;
      }
      const meta = clients.get(ws);
      if (meta?.roomId) {
        const room = rooms.get(meta.roomId);
        if (room) {
          if (room.isBotMatch) {
            stopRoomTimer(room);
            rooms.delete(meta.roomId);
            clients.delete(ws);
            return;
          }
          const isHost = ws === room.hostWs;
          const otherWs = isHost ? room.guestWs : room.hostWs;
          const hostCol = room.hostMeta?.color || 'green';
          const guestCol = room.guestMeta?.color || (hostCol === 'green' ? 'red' : 'green');
          const loserColor = isHost ? hostCol : guestCol;
          const winnerColor = isHost ? guestCol : hostCol;

          // 1. Si la partie est déjà terminée, supprimer la salle uniquement si les deux joueurs sont partis
          if (room.gameOver) {
            if ((!room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) &&
                (!room.guestWs || room.guestWs.readyState !== WebSocket.OPEN)) {
              rooms.delete(meta.roomId);
            }
            clients.delete(ws);
            return;
          }

          // 2. Si la partie n'a pas encore commencé (attente dans le salon / lobby)
          if (!room.gameStarted) {
            stopRoomTimer(room);
            if (otherWs && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'OPPONENT_LEFT',
                event: 'OPPONENT_LEFT',
                reason: 'lobby_exit',
                message: "L'adversaire a quitté le salon d'attente.",
              }));
            }
            rooms.delete(meta.roomId);
            clients.delete(ws);
            return;
          }

          // 3. 🛡️ PARTIE EN COURS : TOLÉRANCE STRICTE AUX MICRO-COUPURES RÉSEAU (4G/Wi-Fi)
          // Ne JAMAIS déclarer de forfait immédiat sur une simple fermeture de socket !
          // On suspend le minuteur et on offre un délai de grâce de 15 secondes pour reconnexion silencieuse.
          stopRoomTimer(room);
          room.isPausedForReconnect = true;

          // Si l'autre joueur est toujours connecté, l'avertir et lancer le compte à rebours
          if (otherWs && otherWs.readyState === WebSocket.OPEN) {
            const BUFFER_SEC = 15;
            room.disconnectBufferSec = BUFFER_SEC;

            if (room.disconnectTimeout) {
              clearTimeout(room.disconnectTimeout);
              room.disconnectTimeout = null;
            }
            if (room.disconnectInterval) {
              clearInterval(room.disconnectInterval);
              room.disconnectInterval = null;
            }

            otherWs.send(JSON.stringify({
              type: 'OPPONENT_DISCONNECTED_BUFFER',
              event: 'OPPONENT_DISCONNECTED_BUFFER',
              bufferSec: BUFFER_SEC,
              message: "⚠️ Micro-coupure adverse (4G/Wi-Fi). Maintien de session (15s)...",
            }));

            room.disconnectInterval = setInterval(() => {
              if (!rooms.has(room.id) || !room.isPausedForReconnect) {
                if (room.disconnectInterval) {
                  clearInterval(room.disconnectInterval);
                  room.disconnectInterval = null;
                }
                return;
              }
              room.disconnectBufferSec = (room.disconnectBufferSec || BUFFER_SEC) - 1;
              if (otherWs.readyState === WebSocket.OPEN) {
                otherWs.send(JSON.stringify({
                  type: 'DISCONNECT_BUFFER_TICK',
                  event: 'DISCONNECT_BUFFER_TICK',
                  remainingSec: room.disconnectBufferSec,
                }));
              }
            }, 1000);

            // Le forfait définitif n'est déclaré QUE si le délai de grâce (15s) s'est entièrement écoulé sans reconnexion
            room.disconnectTimeout = setTimeout(() => {
              if (room.disconnectInterval) {
                clearInterval(room.disconnectInterval);
                room.disconnectInterval = null;
              }
              if (room.isPausedForReconnect && !room.gameOver) {
                room.gameOver = true;
                room.winner = winnerColor;
                room.gameOverReason = 'opponent_left';

                if (otherWs.readyState === WebSocket.OPEN) {
                  otherWs.send(JSON.stringify({
                    type: 'OPPONENT_LEFT',
                    event: 'OPPONENT_LEFT',
                    reason: 'disconnect_timeout',
                    role: meta.role,
                    winner: winnerColor,
                    loser: loserColor,
                    message: "Victoire par forfait ! L'adversaire a perdu la connexion (délai dépassé).",
                  }));
                }
                rooms.delete(meta.roomId);
              }
            }, BUFFER_SEC * 1000);
          } else {
            // Si les deux joueurs ont perdu la connexion en même temps, accorder également 15s de grâce
            const BUFFER_SEC = 15;
            if (room.disconnectTimeout) clearTimeout(room.disconnectTimeout);
            room.disconnectTimeout = setTimeout(() => {
              if ((!room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) &&
                  (!room.guestWs || room.guestWs.readyState !== WebSocket.OPEN)) {
                rooms.delete(meta.roomId);
              }
            }, BUFFER_SEC * 1000);
          }
        }
      }
      clients.delete(ws);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`12 PIONS Game Server running on port ${PORT}`);
  });
}

startServer();
