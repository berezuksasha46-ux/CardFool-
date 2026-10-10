const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase Configuration (с авто-фоллбеком в память при отсутствии ключей)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://your-supabase-url.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let useMemoryFallback = false;
const memoryUsers = new Map();

async function dbGetOrCreateUser(telegramId, userData) {
  if (useMemoryFallback) {
    if (!memoryUsers.has(telegramId)) {
      memoryUsers.set(telegramId, {
        telegram_id: telegramId,
        username: userData.username || 'Player',
        first_name: userData.first_name || 'Gamer',
        stars_balance: 0,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null,
        referrer_id: userData.referrer_id || null,
        is_admin: false
      });
    }
    return memoryUsers.get(telegramId);
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error && error.code === 'PGRST116') {
      const newUser = {
        telegram_id: telegramId,
        username: userData.username || 'Player',
        first_name: userData.first_name || 'Gamer',
        stars_balance: 0,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null,
        referrer_id: userData.referrer_id || null,
        is_admin: false
      };
      const { data: inserted, error: insertErr } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .single();
      if (insertErr) throw insertErr;
      return inserted;
    } else if (error) {
      throw error;
    }
    return data;
  } catch (err) {
    console.warn('Supabase error, switching to memory fallback:', err.message);
    useMemoryFallback = true;
    return dbGetOrCreateUser(telegramId, userData);
  }
}

async function dbUpdateUser(telegramId, updateFields) {
  if (useMemoryFallback) {
    const user = memoryUsers.get(telegramId);
    if (user) {
      Object.assign(user, updateFields);
      memoryUsers.set(telegramId, user);
    }
    return user;
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update(updateFields)
      .eq('telegram_id', telegramId)
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('Supabase update error:', err.message);
    useMemoryFallback = true;
    return dbUpdateUser(telegramId, updateFields);
  }
}

async function dbGetLeaderboard() {
  if (useMemoryFallback) {
    return Array.from(memoryUsers.values())
      .filter(u => u.wins > 0)
      .sort((a, b) => b.wins - a.wins)
      .slice(0, 50);
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id, username, first_name, stars_balance, wins, level')
      .gt('wins', 0)
      .order('wins', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data;
  } catch (err) {
    useMemoryFallback = true;
    return dbGetLeaderboard();
  }
}

// Игровая логика
const tables = new Map(); // tableId -> Table Object
const activeGames = new Map(); // gameId -> Game State

function createDeck(deckSize) {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks24 = ['9', '10', 'J', 'Q', 'K', 'A'];
  const ranks36 = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const ranks = deckSize === 24 ? ranks24 : ranks36;
  const rankValues = { '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };

  let deck = [];
  for (let s of suits) {
    for (let r of ranks) {
      deck.push({ suit: s, rank: r, value: rankValues[r] });
    }
  }
  // Перемешивание (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardComparator(c1, c2, trumpSuit) {
  if (c1.suit === c2.suit) return c1.value - c2.value;
  if (c1.suit === trumpSuit) return 1;
  if (c2.suit === trumpSuit) return -1;
  return 0;
}

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('auth', async (data) => {
    const { telegram_id, username, first_name, referrer_id } = data;
    currentUser = await dbGetOrCreateUser(telegram_id, { username, first_name, referrer_id });
    
    // Обработка реферала при первом входе
    if (referrer_id && !currentUser.referrer_id && Number(referrer_id) !== Number(telegram_id)) {
      await dbUpdateUser(telegram_id, { referrer_id: Number(referrer_id) });
      const refUser = await dbGetOrCreateUser(Number(referrer_id), {});
      if (refUser) {
        await dbUpdateUser(Number(referrer_id), { stars_balance: refUser.stars_balance + 10 });
      }
    }

    socket.emit('auth_success', currentUser);
    emitLobbies();
  });

  socket.on('claim_daily', async () => {
    if (!currentUser) return;
    const now = new Date();
    const lastClaim = currentUser.last_daily_claim ? new Date(currentUser.last_daily_claim) : null;
    
    if (lastClaim && (now - lastClaim) < 24 * 60 * 60 * 1000) {
      const diff = 24 * 60 * 60 * 1000 - (now - lastClaim);
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      socket.emit('daily_error', { message: `Ежедневный бонус уже получен. Следующий доступен через ${hours} ч. ${minutes} мин.` });
      return;
    }

    currentUser.stars_balance += 10;
    currentUser.last_daily_claim = now.toISOString();
    await dbUpdateUser(currentUser.telegram_id, {
      stars_balance: currentUser.stars_balance,
      last_daily_claim: currentUser.last_daily_claim
    });
    socket.emit('auth_success', currentUser);
    socket.emit('daily_success', { amount: 10 });
  });

  socket.on('create_table', async (config) => {
    if (!currentUser) return;
    const { mode, deckSize, stake } = config; // mode: 'podkidnoy' | 'perevodnoy'

    if (currentUser.stars_balance < stake) {
      socket.emit('error_message', 'Недостаточно звезд на балансе!');
      return;
    }

    // Проверка лимита: строго 1 активный стол в ожидании
    for (let t of tables.values()) {
      if (t.hostId === currentUser.telegram_id && t.status === 'waiting') {
        socket.emit('error_message', 'У вас уже есть активный созданный стол!');
        return;
      }
    }

    const tableId = 'table_' + Math.random().toString(36).substr(2, 9);
    const newTable = {
      id: tableId,
      hostId: currentUser.telegram_id,
      hostName: currentUser.first_name || currentUser.username,
      hostLevel: currentUser.level || 1,
      mode,
      deckSize: Number(deckSize),
      stake: Number(stake),
      status: 'waiting'
    };

    tables.set(tableId, newTable);
    socket.emit('table_created', tableId);
    emitLobbies();
  });

  socket.on('join_table', async (tableId) => {
    if (!currentUser) return;
    const table = tables.get(tableId);
    if (!table || table.status !== 'waiting') {
      socket.emit('error_message', 'Стол не найден или уже запущен!');
      return;
    }
    if (table.hostId === currentUser.telegram_id) {
      socket.emit('error_message', 'Нельзя присоединиться к своему столу!');
      return;
    }
    if (currentUser.stars_balance < table.stake) {
      socket.emit('error_message', 'Недостаточно звезд для входа на этот стол!');
      return;
    }

    // Списание ставок с обоих
    const hostUser = await dbGetOrCreateUser(table.hostId, {});
    if (hostUser.stars_balance < table.stake) {
      tables.delete(tableId);
      emitLobbies();
      socket.emit('error_message', 'У создателя стола недостаточно средств!');
      return;
    }

    await dbUpdateUser(hostUser.telegram_id, { stars_balance: hostUser.stars_balance - table.stake });
    await dbUpdateUser(currentUser.telegram_id, { stars_balance: currentUser.stars_balance - table.stake });
    
    currentUser.stars_balance -= table.stake;
    socket.emit('auth_success', currentUser);

    table.status = 'playing';
    const gameId = 'game_' + tableId;
    table.gameId = gameId;

    // Инициализация игры
    const deck = createDeck(table.deckSize);
    const trumpCard = deck[deck.length - 1];
    const p1Hand = deck.splice(0, 6);
    const p2Hand = deck.splice(0, 6);

    const gameState = {
      gameId,
      tableId,
      mode: table.mode,
      stake: table.stake,
      deck,
      trumpCard,
      players: [
        { id: hostUser.telegram_id, name: hostUser.first_name, level: hostUser.level, hand: p1Hand, socketId: null },
        { id: currentUser.telegram_id, name: currentUser.first_name, level: currentUser.level, hand: p2Hand, socketId: socket.id }
      ],
      attackerIndex: 0, // 0 или 1
      defenderIndex: 1,
      tableCards: [], // массив пар {attack, defend: null}
      status: 'playing',
      timer: 15,
      timerInterval: null
    };

    // Находим socketId хоста
    for (let s of io.sockets.sockets.values()) {
      // Можно привязать socket к telegram_id при auth
      if (s.handshake.query.telegram_id == hostUser.telegram_id || s._telegram_id == hostUser.telegram_id) {
        gameState.players[0].socketId = s.id;
        s.join(gameId);
      }
    }
    socket.join(gameId);
    gameState.players[1].socketId = socket.id;

    activeGames.set(gameId, gameState);
    tables.delete(tableId);
    emitLobbies();

    startGameLoop(gameId);
  });

  socket.on('set_socket_user', (telegram_id) => {
    socket._telegram_id = telegram_id;
  });

  socket.on('game_action', (data) => {
    handleGameAction(socket, data);
  });

  socket.on('get_lobbies', () => {
    emitLobbies(socket);
  });

  async function emitLobbies(targetSocket = io) {
    const list = Array.from(tables.values());
    targetSocket.emit('lobbies_list', { tables: list, currentUserId: currentUser?.telegram_id });
  }
});

function startGameLoop(gameId) {
  const game = activeGames.get(gameId);
  if (!game) return;

  broadcastGameState(game);
  resetTurnTimer(game);
}

function resetTurnTimer(game) {
  if (game.timerInterval) clearInterval(game.timerInterval);
  game.timer = 15;

  game.timerInterval = setInterval(() => {
    game.timer--;
    io.to(game.gameId).emit('timer_update', game.timer);

    if (game.timer <= 0) {
      clearInterval(game.timerInterval);
      // Авто-действие по таймауту (если защищается - берет карты, если атакует - пасует/завершает)
      handleTimeout(game);
    }
  }, 1000);
}

function handleTimeout(game) {
  const defender = game.players[game.defenderIndex];
  // Автоматический «Беру» для защищающегося или «Бито» / авто-пас для атаки
  if (game.tableCards.length > 0 && game.tableCards.some(c => !c.defend)) {
    // Защитник берет все карты
    defender.hand.push(...game.tableCards.map(c => c.attack));
    if (c => c.defend) defender.hand.push(...game.tableCards.filter(c => c.defend).map(c => c.defend));
    game.tableCards = [];
    // Меняем роли
    const temp = game.attackerIndex;
    game.attackerIndex = game.defenderIndex;
    game.defenderIndex = temp;
    refillHands(game);
    checkWinCondition(game);
  } else {
    // Смена хода
    game.tableCards = [];
    const temp = game.attackerIndex;
    game.attackerIndex = game.defenderIndex;
    game.defenderIndex = temp;
    refillHands(game);
    checkWinCondition(game);
  }
  broadcastGameState(game);
  if (game.status === 'playing') resetTurnTimer(game);
}

function refillHands(game) {
  while (game.players[game.attackerIndex].hand.length < 6 && game.deck.length > 0) {
    game.players[game.attackerIndex].hand.push(game.deck.pop());
  }
  while (game.players[game.defenderIndex].hand.length < 6 && game.deck.length > 0) {
    game.players[game.defenderIndex].hand.push(game.deck.pop());
  }
}

function broadcastGameState(game) {
  const p1 = game.players[0];
  const p2 = game.players[1];

  io.to(game.gameId).emit('game_state', {
    gameId: game.gameId,
    mode: game.mode,
    stake: game.stake,
    trumpCard: game.trumpCard,
    deckCount: game.deck.length,
    tableCards: game.tableCards,
    attackerIndex: game.attackerIndex,
    defenderIndex: game.defenderIndex,
    players: [
      { id: p1.id, name: p1.name, level: p1.level, handCount: p1.hand.length, hand: p1.id === p1IdPlaceholder ? p1.hand : null },
      { id: p2.id, name: p2.name, level: p2.level, handCount: p2.hand.length }
    ]
  });

  // Отправляем персонально руки игрокам
  for (let p of game.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      sock.emit('your_hand', p.hand);
      sock.emit('is_my_turn', game.players[game.attackerIndex].id === p.id || (game.tableCards.length > 0 && game.players[game.defenderIndex].id === p.id));
    }
  }
}
const p1IdPlaceholder = null; // helper

async function handleGameAction(socket, data) {
  const { gameId, action, cardIndex, targetCardIndex } = data;
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'playing') return;

  const playerIdx = game.players.findIndex(p => p.socketId === socket.id);
  if (playerIdx === -1) return;

  const isAttacker = game.attackerIndex === playerIdx;
  const isDefender = game.defenderIndex === playerIdx;

  if (action === 'attack' && isAttacker) {
    const card = game.players[playerIdx].hand[cardIndex];
    if (!card) return;

    // Проверка возможности подкидывания (ранг должен совпадать с имеющимися на столе картами)
    if (game.tableCards.length > 0) {
      const ranksOnTable = new Set();
      game.tableCards.forEach(tc => {
        ranksOnTable.add(tc.attack.rank);
        if (tc.defend) ranksOnTable.add(tc.defend.rank);
      });
      if (!ranksOnTable.has(card.rank)) return;
    }

    game.players[playerIdx].hand.splice(cardIndex, 1);
    game.tableCards.push({ attack: card, defend: null });
    resetTurnTimer(game);
    broadcastGameState(game);
    checkWinCondition(game);
  } 
  else if (action === 'defend' && isDefender) {
    const attackPair = game.tableCards.find(tc => !tc.defend);
    if (!attackPair) return;

    const defCard = game.players[playerIdx].hand[cardIndex];
    if (!defCard) return;

    // Проверяем возможность побить карту
    const isValid = (defCard.suit === attackPair.attack.suit && defCard.value > attackPair.attack.value) ||
                    (defCard.suit === game.trumpCard.suit && attackPair.attack.suit !== game.trumpCard.suit);

    if (isValid) {
      game.players[playerIdx].hand.splice(cardIndex, 1);
      attackPair.defend = defCard;
      resetTurnTimer(game);
      broadcastGameState(game);
      checkWinCondition(game);
    } else {
      socket.emit('error_message', 'Этой картой побить нельзя!');
    }
  }
  else if (action === 'transfer' && isDefender && game.mode === 'perevodnoy') {
    // Переводной дурак: можно перевести, если есть карта того же ранга что и последняя атака, и на столе нет отбитых карт (или все не отбиты, правила классики)
    const attackPair = game.tableCards.find(tc => !tc.defend);
    const card = game.players[playerIdx].hand[cardIndex];
    if (!attackPair || !card || card.rank !== attackPair.attack.rank) return;
    if (game.tableCards.some(tc => tc.defend)) return; // перевод только пока не начали отбивать

    game.players[playerIdx].hand.splice(cardIndex, 1);
    game.tableCards.push({ attack: card, defend: null });
    // Меняем роли атакующего и защищающегося местами!
    const temp = game.attackerIndex;
    game.attackerIndex = game.defenderIndex;
    game.defenderIndex = temp;
    resetTurnTimer(game);
    broadcastGameState(game);
  }
  else if (action === 'take' && isDefender) {
    // Защитник берет все карты со стола
    const cardsToTake = [];
    game.tableCards.forEach(tc => {
      cardsToTake.push(tc.attack);
      if (tc.defend) cardsToTake.push(tc.defend);
    });
    game.players[playerIdx].hand.push(...cardsToTake);
    game.tableCards = [];

    // Атакующий ходит снова, защитник пропускает ход (меняем только если атакующий бил, а тут защитник взял, значит атакующий ходит опять или следующий)
    const temp = game.attackerIndex;
    game.attackerIndex = game.defenderIndex;
    game.defenderIndex = temp;

    refillHands(game);
    resetTurnTimer(game);
    broadcastGameState(game);
    checkWinCondition(game);
  }
  else if (action === 'done' && isAttacker) {
    // Атакующий завершает ход (все отбито)
    if (game.tableCards.length > 0 && game.tableCards.every(tc => tc.defend)) {
      game.tableCards = [];
      const temp = game.attackerIndex;
      game.attackerIndex = game.defenderIndex;
      game.defenderIndex = temp;
      refillHands(game);
      resetTurnTimer(game);
      broadcastGameState(game);
      checkWinCondition(game);
    }
  }
}

async function checkWinCondition(game) {
  if (game.deck.length === 0) {
    const p1Empty = game.players[0].hand.length === 0;
    const p2Empty = game.players[1].hand.length === 0;

    if (p1Empty || p2Empty) {
      if (game.timerInterval) clearInterval(game.timerInterval);
      game.status = 'finished';

      let winner = null;
      let loser = null;

      if (p1Empty && !p2Empty) {
        winner = game.players[0];
        loser = game.players[1];
      } else if (p2Empty && !p1Empty) {
        winner = game.players[1];
        loser = game.players[0];
      } else {
        // Ничья или кто первый скинул
        winner = game.players[0];
        loser = game.players[1];
      }

      // Расчет банка и комиссии 10%
      const totalPot = game.stake * 2;
      const commission = totalPot * 0.10;
      const prize = totalPot - commission;

      const winnerUser = await dbGetOrCreateUser(winner.id, {});
      const loserUser = await dbGetOrCreateUser(loser.id, {});

      await dbUpdateUser(winner.id, {
        stars_balance: winnerUser.stars_balance + Math.floor(prize),
        wins: winnerUser.wins + 1,
        level: Math.floor((winnerUser.wins + 1) / 5) + 1
      });

      await dbUpdateUser(loser.id, {
        losses: loserUser.losses + 1
      });

      // Реферальный бонус 5% от ставок для аплайна
      if (winnerUser.referrer_id) {
        const refUser = await dbGetOrCreateUser(winnerUser.referrer_id, {});
        if (refUser) {
          const refBonus = Math.floor(game.stake * 0.05);
          await dbUpdateUser(refUser.telegram_id, { stars_balance: refUser.stars_balance + refBonus });
        }
      }

      io.to(game.gameId).emit('game_over', {
        winnerId: winner.id,
        winnerName: winner.name,
        prize: Math.floor(prize)
      });

      activeGames.delete(game.gameId);
    }
  }
}

app.get('/api/leaderboard', async (req, res) => {
  const lb = await dbGetLeaderboard();
  res.json(lb);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CardFool server running on port ${PORT}`);
});
