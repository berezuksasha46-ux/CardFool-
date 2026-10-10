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
app.use(express.static(__dirname));

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
        photo_url: userData.photo_url || null,
        stars_balance: userData.stars_balance !== undefined ? userData.stars_balance : 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null,
        referrer_id: userData.referrer_id || null
      });
    } else {
      // Обновляем photo_url и имя, если они изменились
      const existing = memoryUsers.get(telegramId);
      if (userData.photo_url) existing.photo_url = userData.photo_url;
      if (userData.first_name) existing.first_name = userData.first_name;
    }
    return memoryUsers.get(telegramId);
  }

  try {
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (error && error.code === 'PGRST116') {
      const newUser = {
        telegram_id: telegramId,
        username: userData.username || 'Player',
        first_name: userData.first_name || 'Gamer',
        photo_url: userData.photo_url || null,
        stars_balance: 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null,
        referrer_id: userData.referrer_id || null
      };
      const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
      if (insertErr) throw insertErr;
      return inserted;
    } else if (error) throw error;
    
    // Если пользователь найден, подтягиваем актуальную аватарку, если она прилетела
    if (userData.photo_url && data.photo_url !== userData.photo_url) {
      await supabase.from('users').update({ photo_url: userData.photo_url }).eq('telegram_id', telegramId);
      data.photo_url = userData.photo_url;
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
    if (user) Object.assign(user, updateFields);
    return user;
  }
  try {
    const { data, error } = await supabase.from('users').update(updateFields).eq('telegram_id', telegramId).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    useMemoryFallback = true;
    return dbUpdateUser(telegramId, updateFields);
  }
}

async function dbGetLeaderboard() {
  if (useMemoryFallback) {
    return Array.from(memoryUsers.values()).sort((a, b) => b.wins - a.wins).slice(0, 50);
  }
  try {
    const { data, error } = await supabase.from('users').select('telegram_id, username, first_name, photo_url, stars_balance, wins, level').order('wins', { ascending: false }).limit(50);
    if (error) throw error;
    return data;
  } catch (err) {
    useMemoryFallback = true;
    return dbGetLeaderboard();
  }
}

const tables = new Map();
const activeGames = new Map();

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
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('auth', async (data) => {
    const { telegram_id, username, first_name, photo_url, referrer_id } = data;
    if (!telegram_id) return;
    
    currentUser = await dbGetOrCreateUser(telegram_id, { username, first_name, photo_url, referrer_id });
    socket._telegram_id = telegram_id;
    socket.emit('auth_success', currentUser);
    emitLobbies();
  });

  socket.on('set_socket_user', (telegram_id) => {
    socket._telegram_id = telegram_id;
  });

  socket.on('get_lobbies', () => {
    emitLobbies(socket);
  });

  socket.on('create_table', async (config) => {
    if (!currentUser && socket._telegram_id) {
      currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    }
    if (!currentUser) return;

    const { mode, deckSize, stake } = config;

    if (currentUser.stars_balance < stake) {
      socket.emit('error_message', 'Недостаточно звезд на балансе!');
      return;
    }

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    const newTable = {
      id: tableId,
      hostId: currentUser.telegram_id,
      hostName: currentUser.first_name || currentUser.username,
      mode: mode || 'podkidnoy',
      deckSize: Number(deckSize) || 36,
      stake: Number(stake) || 10,
      status: 'waiting'
    };

    tables.set(tableId, newTable);
    socket.join(tableId);
    socket.emit('table_created', tableId);
    emitLobbies();
  });

  socket.on('join_table', async (data) => {
    if (!currentUser && socket._telegram_id) {
      currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    }
    if (!currentUser) return;

    const tableId = typeof data === 'object' ? (data.tableId || data.gameId) : data;
    const table = tables.get(tableId);

    if (activeGames.has(tableId)) {
      socket.join(tableId);
      const game = activeGames.get(tableId);
      broadcastGameState(game);
      return;
    }

    if (!table) {
      socket.emit('error_message', 'Стол не найден или уже запущен!');
      return;
    }

    if (table.hostId === currentUser.telegram_id) {
      socket.join(tableId);
      socket.emit('game_state', {
        gameId: tableId,
        deckCount: table.deckSize,
        trumpCard: '♠',
        tableCards: [],
        players: [{ name: table.hostName, handCount: 0 }]
      });
      return;
    }

    if (currentUser.stars_balance < table.stake) {
      socket.emit('error_message', 'Недостаточно звезд для входа!');
      return;
    }

    table.status = 'playing';
    const gameId = tableId;

    const deck = createDeck(table.deckSize);
    const trumpCard = deck[deck.length - 1];
    const p1Hand = deck.splice(0, 6);
    const p2Hand = deck.splice(0, 6);

    const hostUser = await dbGetOrCreateUser(table.hostId, {});

    const gameState = {
      gameId,
      tableId,
      mode: table.mode,
      stake: table.stake,
      deck,
      trumpCard,
      players: [
        { id: hostUser.telegram_id, name: hostUser.first_name || hostUser.username, level: hostUser.level || 1, hand: p1Hand, socketId: null },
        { id: currentUser.telegram_id, name: currentUser.first_name || currentUser.username, level: currentUser.level || 1, hand: p2Hand, socketId: socket.id }
      ],
      attackerIndex: 0,
      defenderIndex: 1,
      tableCards: [],
      status: 'playing'
    };

    for (let s of io.sockets.sockets.values()) {
      if (s._telegram_id == hostUser.telegram_id) {
        gameState.players[0].socketId = s.id;
        s.join(gameId);
      }
    }

    socket.join(gameId);
    activeGames.set(gameId, gameState);
    tables.delete(tableId);
    emitLobbies();

    broadcastGameState(gameState);
  });

  socket.on('game_action', async (data) => {
    if (!currentUser && socket._telegram_id) {
      currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    }
    handleGameAction(socket, data);
  });

  async function emitLobbies(targetSocket = io) {
    const list = Array.from(tables.values());
    targetSocket.emit('lobbies_list', { tables: list });
  }
});

function broadcastGameState(game) {
  const p1 = game.players[0];
  const p2 = game.players[1];

  io.to(game.gameId).emit('game_state', {
    gameId: game.gameId,
    deckCount: game.deck.length,
    trumpCard: game.trumpCard,
    tableCards: game.tableCards,
    players: [
      { name: p1.name, handCount: p1.hand.length },
      { name: p2.name, handCount: p2.hand.length }
    ]
  });

  const sock1 = io.sockets.sockets.get(p1.socketId);
  const sock2 = io.sockets.sockets.get(p2.socketId);

  if (sock1) {
    sock1.emit('your_hand', p1.hand);
    sock1.emit('is_my_turn', game.attackerIndex === 0);
  }
  if (sock2) {
    sock2.emit('your_hand', p2.hand);
    sock2.emit('is_my_turn', game.attackerIndex === 1);
  }
}

async function handleGameAction(socket, data) {
  const { gameId, action, cardIndex } = data;
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'playing') return;

  const playerIdx = game.players.findIndex(p => p.socketId === socket.id);
  if (playerIdx === -1) return;

  const isAttacker = game.attackerIndex === playerIdx;
  const isDefender = game.defenderIndex === playerIdx;

  if (action === 'play_card' && isAttacker) {
    const card = game.players[playerIdx].hand[cardIndex];
    if (!card) return;

    game.players[playerIdx].hand.splice(cardIndex, 1);
    game.tableCards.push({ attack: card, defend: null });
    
    const temp = game.attackerIndex;
    game.attackerIndex = game.defenderIndex;
    game.defenderIndex = temp;

    broadcastGameState(game);
  } 
  else if (action === 'play_card' && isDefender) {
    const attackPair = game.tableCards.find(tc => !tc.defend);
    if (!attackPair) return;

    const defCard = game.players[playerIdx].hand[cardIndex];
    if (!defCard) return;

    const isValid = (defCard.suit === attackPair.attack.suit && defCard.value > attackPair.attack.value) ||
                    (defCard.suit === game.trumpCard.suit && attackPair.attack.suit !== game.trumpCard.suit);

    if (isValid) {
      game.players[playerIdx].hand.splice(cardIndex, 1);
      attackPair.defend = defCard;

      const temp = game.attackerIndex;
      game.attackerIndex = game.defenderIndex;
      game.defenderIndex = temp;

      broadcastGameState(game);
      checkWin(game);
    } else {
      socket.emit('error_message', 'Этой картой побить нельзя!');
    }
  }
  else if (action === 'bito' && isAttacker) {
    if (game.tableCards.length > 0 && game.tableCards.every(tc => tc.defend)) {
      game.tableCards = [];
      refillHands(game);
      broadcastGameState(game);
      checkWin(game);
    }
  }
  else if (action === 'take' && isDefender) {
    const cardsToTake = [];
    game.tableCards.forEach(tc => {
      cardsToTake.push(tc.attack);
      if (tc.defend) cardsToTake.push(tc.defend);
    });
    game.players[playerIdx].hand.push(...cardsToTake);
    game.tableCards = [];
    refillHands(game);
    
    const temp = game.attackerIndex;
    game.attackerIndex = game.defenderIndex;
    game.defenderIndex = temp;

    broadcastGameState(game);
    checkWin(game);
  }
}

function refillHands(game) {
  while (game.players[game.attackerIndex].hand.length < 6 && game.deck.length > 0) {
    game.players[game.attackerIndex].hand.push(game.deck.pop());
  }
  while (game.players[game.defenderIndex].hand.length < 6 && game.deck.length > 0) {
    game.players[game.defenderIndex].hand.push(game.deck.pop());
  }
}

async function checkWin(game) {
  if (game.deck.length === 0) {
    const p0Empty = game.players[0].hand.length === 0;
    const p1Empty = game.players[1].hand.length === 0;

    if (p0Empty || p1Empty) {
      game.status = 'finished';
      const winner = p0Empty ? game.players[0] : game.players[1];
      io.to(game.gameId).emit('game_over', { winnerName: winner.name, prize: game.stake * 2 });
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
