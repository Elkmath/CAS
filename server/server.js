
const { createServer } = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const httpServer = createServer((req, res) => {
  // ── 실험 데이터 수신 ──
  if (req.method === 'POST' && req.url === '/experiment-result') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const entry = {
          timestamp: new Date().toISOString(),
          ...data
        };

        // results.json 에 누적 저장
        const filePath = path.join(__dirname, 'results.json');
        let existing = [];
        if (fs.existsSync(filePath)) {
          try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
        }
        existing.push(entry);
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');

        console.log(`\n📊 실험 결과 수신 [${entry.timestamp}]`);
        if (data.rows) {
          console.log('색        | 자극수준 | 자극순위 | 반응순위 | 순위차이');
          console.log('─'.repeat(52));
          data.rows.forEach(r => {
            console.log(`${r.color.padEnd(8)} | ${String(r.stimLevel).padEnd(8)} | ${String(r.stimRank).padEnd(8)} | ${String(r.rtRank).padEnd(8)} | ${r.diff}`);
          });
          console.log(`평균 순위 차이: ${data.avgDiff}  일치 점수: ${data.matchScore}%`);
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('결과 파싱 오류:', e);
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, '../client/index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Public 모드 상태 관리
const publicWaitingPlayers = [];
const games = new Map();
const playerToGame = new Map();
let roomCounter = 1;

// Private 모드 상태 관리
const privateRooms = new Map(); // roomCode -> { hostSocketId, hostNickname, guestSocketId, guestNickname, gameId }

// 멀티 모드 문제 생성 함수 (기존과 동일)
function generateMathProblem(index, seed) {
  const problemTypes = ['add', 'sub', 'mul', 'pow', 'div'];
  const type = problemTypes[(seed + index * 13) % 5];
  
  const n = (seed * (index + 1)) % 10000;
  const a = (n * 123 + 456) % 990 + 10;
  const b = (n * 789 + 321) % 990 + 10;
  const c = (n * 555 + 777) % 19 + 2;
  const d = (n * 888 + 222) % 19 + 2;
  const e = (n * 333 + 666) % 91 + 10;
  const f = (n * 444 + 111) % 91 + 10;
  const g = (n * 999 + 555) % 91 + 10;
  
  let problem, answer;
  
  switch(type) {
    case 'add':
      answer = a + b;
      problem = `${a} + ${b} = ?`;
      break;
      
    case 'sub':
      const max = Math.max(a, b);
      const min = Math.min(a, b);
      answer = max - min;
      problem = `${max} - ${min} = ?`;
      break;
      
    case 'mul':
      answer = c * d;
      problem = `${c} × ${d} = ?`;
      break;
      
    case 'pow':
      answer = e * e;
      problem = `${e}² = ?`;
      break;
      
    case 'div':
      const product = f * g;
      if ((seed + index) % 2 === 0) {
        answer = g;
        problem = `${product} ÷ ${f} = ?`;
      } else {
        answer = f;
        problem = `${product} ÷ ${g} = ?`;
      }
      break;
  }
  
  return { problem, answer };
}

function createGameProblems(roomId) {
  const problems = [];
  const randomSeed = Math.floor(Math.random() * 10000) + 1;
  const gameSeed = roomId * 10000 + randomSeed;
  
  for (let i = 0; i < 50; i++) {
    problems.push(generateMathProblem(i, gameSeed));
  }
  
  return problems;
}

function createGame(player1, player2, isPrivate = false) {
  const roomId = roomCounter++;
  const gameId = `game_${roomId}`;
  
  const problems = createGameProblems(roomId);
  
  const game = {
    id: gameId,
    roomId: roomId,
    players: {
      [player1.id]: {
        socketId: player1.id,
        nickname: player1.nickname,
        score: 0,
        currentProblemIndex: 0,
        hasAnswered: false,
        problems: problems
      },
      [player2.id]: {
        socketId: player2.id,
        nickname: player2.nickname,
        score: 0,
        currentProblemIndex: 0,
        hasAnswered: false,
        problems: problems
      }
    },
    startTime: Date.now(),
    isFinished: false,
    timer: null,
    countdownTimer: null,
    isCountingDown: true,
    isPrivate: isPrivate
  };
  
  games.set(gameId, game);
  playerToGame.set(player1.id, gameId);
  playerToGame.set(player2.id, gameId);
  
  startCountdown(gameId);
  return game;
}

function startCountdown(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  let countdown = 5;
  
  Object.values(game.players).forEach(player => {
    io.to(player.socketId).emit('countdownStart', {
      message: 'Opponent found!',
      countdown: countdown
    });
  });
  
  game.countdownTimer = setInterval(() => {
    countdown--;
    
    Object.values(game.players).forEach(player => {
      io.to(player.socketId).emit('countdownUpdate', {
        countdown: countdown
      });
    });
    
    if (countdown <= 0) {
      clearInterval(game.countdownTimer);
      game.isCountingDown = false;
      startGame(gameId);
    }
  }, 1000);
}

function startGame(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  Object.values(game.players).forEach(player => {
    const playerIds = Object.keys(game.players);
    const opponentId = playerIds.find(id => id !== player.socketId);
    const opponent = game.players[opponentId];
    const currentProblem = player.problems[0];
    
    io.to(player.socketId).emit('gameStart', {
      opponent: opponent.nickname,
      opponentScore: 0,
      problem: currentProblem.problem,
      score: 0,
      timeLeft: 90
    });
  });
  
  game.timer = setTimeout(() => endGame(gameId), 90000);
}

function endGame(gameId) {
  const game = games.get(gameId);
  if (!game || game.isFinished) return;
  
  game.isFinished = true;
  
  const players = Object.values(game.players);
  const [p1, p2] = players;
  
  let resultText = p1.score > p2.score ? `${p1.nickname} 승리` :
                   p2.score > p1.score ? `${p2.nickname} 승리` : '무승부';
  
  const gameResult = {
    result: resultText,
    scores: { [p1.nickname]: p1.score, [p2.nickname]: p2.score },
    finalScores: [
      `${p1.nickname}: ${p1.score.toFixed(1)}점`,
      `${p2.nickname}: ${p2.score.toFixed(1)}점`
    ]
  };
  
  players.forEach(player => {
    io.to(player.socketId).emit('gameFinished', gameResult);
    playerToGame.delete(player.socketId);
  });
  
  if (game.isPrivate) {
    for (const [roomCode, room] of privateRooms.entries()) {
      if (room.gameId === gameId) {
        privateRooms.delete(roomCode);
        break;
      }
    }
  }
  
  if (game.timer) clearTimeout(game.timer);
  if (game.countdownTimer) clearInterval(game.countdownTimer);
  games.delete(gameId);
}

function getOpponentScore(game, socketId) {
  const players = Object.values(game.players);
  const opponent = players.find(p => p.socketId !== socketId);
  return opponent ? opponent.score : 0;
}

function generateRoomCode() {
  return Math.floor(Math.random() * 90000) + 10000;
}

io.on('connection', (socket) => {
  console.log(`🔗 연결: ${socket.id.substring(0, 8)}...`);
  
  socket.on('joinPublicGame', (nickname) => {
    console.log(`👤 Public 참가: ${nickname}`);
    publicWaitingPlayers.push({ id: socket.id, nickname });
    socket.emit('waiting', { message: 'Waiting for opponent...' });
    console.log(`Public 대기열: ${publicWaitingPlayers.length}명`);
    if (publicWaitingPlayers.length >= 2) {
      const player1 = publicWaitingPlayers.shift();
      const player2 = publicWaitingPlayers.shift();
      createGame(player1, player2, false);
    }
  });
  
  socket.on('createPrivateRoom', (nickname) => {
    console.log(`🔐 Private 방 생성: ${nickname}`);
    let roomCode;
    do { roomCode = generateRoomCode(); } while (privateRooms.has(roomCode));
    privateRooms.set(roomCode, {
      hostSocketId: socket.id,
      hostNickname: nickname,
      guestSocketId: null,
      guestNickname: null,
      gameId: null
    });
    console.log(`Private 방 생성됨: ${roomCode}`);
    socket.emit('privateRoomCreated', { roomCode, message: 'Room created successfully' });
  });
  
  socket.on('joinPrivateRoom', (data) => {
    const { nickname, roomCode } = data;
    console.log(`🔐 Private 방 참가 시도: ${nickname}, 코드: ${roomCode}`);
    const room = privateRooms.get(roomCode);
    if (!room) {
      console.log(`❌ 방 없음: ${roomCode}`);
      socket.emit('roomCodeError', { message: 'Room does not exist' });
      return;
    }
    room.guestSocketId = socket.id;
    room.guestNickname = nickname;
    console.log(`✅ Private 방 참가 성공: ${roomCode}`);
    socket.emit('roomJoined', { message: 'Successfully joined the room' });
    io.to(room.hostSocketId).emit('roomJoined', { message: 'Opponent has joined the room' });
    const player1 = { id: room.hostSocketId, nickname: room.hostNickname };
    const player2 = { id: room.guestSocketId, nickname: room.guestNickname };
    const game = createGame(player1, player2, true);
    room.gameId = game.id;
    privateRooms.delete(roomCode);
    console.log(`🔐 Private 방 삭제됨: ${roomCode} (매치 시작)`);
  });
  
  socket.on('submitAnswer', (data) => {
    const gameId = playerToGame.get(socket.id);
    if (!gameId) return;
    const game = games.get(gameId);
    if (!game || game.isFinished || game.isCountingDown) return;
    const player = game.players[socket.id];
    if (!player || player.hasAnswered) return;
    const currentProblem = player.problems[player.currentProblemIndex];
    const userAnswer = parseFloat(data.answer);
    const correctAnswer = currentProblem.answer;
    let isCorrect = false;
    if (Math.abs(userAnswer - correctAnswer) < 0.01) {
      player.score += 1;
      isCorrect = true;
    } else {
      player.score = Math.max(0, player.score - 0.5);
    }
    player.hasAnswered = true;
    const opponentScore = getOpponentScore(game, socket.id);
    socket.emit('answerResult', { isCorrect, correctAnswer, score: player.score, opponentScore });
    const opponentSocketId = Object.keys(game.players).find(id => id !== socket.id);
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('opponentScoreUpdate', { opponentScore: player.score });
    }
    setTimeout(() => {
      if (player.currentProblemIndex + 1 < player.problems.length) {
        player.currentProblemIndex++;
        player.hasAnswered = false;
        const nextProblem = player.problems[player.currentProblemIndex];
        socket.emit('nextProblem', { problem: nextProblem.problem, score: player.score, opponentScore });
      }
    }, 2000);
  });
  
  socket.on('disconnect', () => {
    console.log(`❌ 연결종료: ${socket.id.substring(0, 8)}...`);
    const publicIndex = publicWaitingPlayers.findIndex(p => p.id === socket.id);
    if (publicIndex !== -1) publicWaitingPlayers.splice(publicIndex, 1);
    for (const [roomCode, room] of privateRooms.entries()) {
      if (room.hostSocketId === socket.id) {
        if (room.guestSocketId) io.to(room.guestSocketId).emit('opponentDisconnected', { message: 'Host disconnected' });
        privateRooms.delete(roomCode);
        console.log(`🔐 Private 방 삭제됨: ${roomCode} (호스트 나감)`);
        break;
      } else if (room.guestSocketId === socket.id) {
        room.guestSocketId = null;
        room.guestNickname = null;
        if (room.hostSocketId) io.to(room.hostSocketId).emit('opponentDisconnected', { message: 'Guest disconnected' });
        console.log(`🔐 Guest left room: ${roomCode}`);
        break;
      }
    }
    const gameId = playerToGame.get(socket.id);
    if (gameId) {
      const game = games.get(gameId);
      if (game && !game.isFinished) {
        const opponentSocketId = Object.keys(game.players).find(id => id !== socket.id);
        if (opponentSocketId) {
          const remainingPlayer = game.players[opponentSocketId];
          io.to(opponentSocketId).emit('gameFinished', {
            result: 'Opponent disconnected',
            scores: { [remainingPlayer.nickname]: remainingPlayer.score, 'Opponent': 0.0 }
          });
          io.to(opponentSocketId).emit('opponentDisconnected', { message: 'Opponent disconnected' });
        }
        game.isFinished = true;
        if (game.timer) clearTimeout(game.timer);
        if (game.countdownTimer) clearInterval(game.countdownTimer);
        playerToGame.delete(socket.id);
        if (opponentSocketId) playerToGame.delete(opponentSocketId);
        games.delete(gameId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Math Challenge Server Started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`📊 실험 결과 수신: POST /experiment-result`);
  console.log(`💾 결과 저장 위치: server/results.json`);
});
