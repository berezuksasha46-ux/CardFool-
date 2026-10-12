const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const users = {};           
const uniqueIdToTgId = {};  
const lobbies = {};         
const activeGames = {};     

// Колесо фортуны с независимым непрерывным таймером
const wheelMultipliers = [3, 0.5, 1.5, 0, 2, 0.5, 1.2, 0];
let wheelTimer = 7;
let wheelIsSpinning = false;
let wheelBets = [];

setInterval(() => {
  if (!wheelIsSpinning) {
    wheelTimer--;
    if (wheelTimer <= 0) {
      wheelIsSpinning = true;
      wheelTimer = 5;

      const winningIndex = Math.floor(Math.random() * 8);
      const targetMultiplier = wheelMultipliers[winningIndex];
      const targetDegree = (7 - winningIndex) * 45 + 22.5;

      wheelBets.forEach((bet) => {
        const player = users[bet.telegram_id];
        if (!player) return;
        const winAmount = Math.floor(bet.amount * targetMultiplier);
        player.stars_balance += winAmount;

        io.sockets.sockets.forEach((s) => {
          if (s.userId === player.telegram_id) {
            s.emit('wheel_spin_result', { targetDegree, multiplier: targetMultiplier, winAmount, newBalance: player.stars_balance });
          }
        });
      });

      io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: true, bets: wheelBets });

      setTimeout(() => {
        wheelIsSpinning = false;
        wheelTimer = 7;
        wheelBets = []; 
        io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
      }, 5000);
    } else {
      io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
    }
  }
}, 1000);

function createDeck(size) {
  const suits = ['♠', '♣', '♥', '♦'];
  const allRanks = size === 24 ? ['9', '10', 'J', 'Q', 'K', 'A'] : ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  let idCounter = 1;
  suits.forEach(suit => allRanks.forEach(rank => deck.push({ id: 'c_' + (idCounter++), suit, rank })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
io.on('connection', (socket) => {
  socket.on('auth', (data) => {
    const { telegram_id, username, first_name, photo_url, refId } = data;
    if (!telegram_id) return;

    let user = users[telegram_id];
    if (!user) {
      const newUniqueId = Math.floor(100000 + Math.random() * 900000).toString();
      user = {
        telegram_id: String(telegram_id),
        username: username || 'Игрок',
        first_name: first_name || 'Игрок',
        photo_url: photo_url || '',
        stars_balance: 0, // Стартовый баланс строго 0
        wins: 0, losses: 0,
        unique_id: newUniqueId,
        referrer_id: null,
        activated_promos: [],
        last_daily: 0
      };
      users[telegram_id] = user;
      uniqueIdToTgId[newUniqueId] = telegram_id;

      if (refId && refId !== newUniqueId && refId !== String(telegram_id)) {
        const referrerTgId = uniqueIdToTgId[refId] || refId;
        const referrer = users[referrerTgId];
        if (referrer) {
          user.referrer_id = referrer.unique_id;
          referrer.stars_balance += 10;
        }
      }
    }

    socket.userId = user.telegram_id;
    socket.emit('auth_success', user);
    socket.emit('lobbies_list', { tables: Object.values(lobbies) });
  });

  // Обработка промокодов SUPERRICKY и BETATEST
  socket.on('activate_promo', (data) => {
    const user = users[socket.userId];
    if (!user) return;
    const code = (data?.code || '').trim().toUpperCase();

    if (user.activated_promos.includes(code)) {
      return socket.emit('error_message', 'Вы уже активировали этот промокод!');
    }

    let reward = 0;
    if (code === 'SUPERRICKY') reward = 50;
    else if (code === 'BETATEST') reward = 150;
    else return socket.emit('error_message', 'Неверный промокод!');

    user.activated_promos.push(code);
    user.stars_balance += reward;
    socket.emit('auth_success', user);
    socket.emit('error_message', `🎉 Промокод активирован! Начислено +${reward} ⭐`);
  });

  socket.on('get_friends', () => {
    if (!socket.userId) return;
    const user = users[socket.userId];
    const myReferrals = Object.values(users).filter(u => u.referrer_id === user?.unique_id);
    socket.emit('friends_list', { friends: myReferrals });
  });

  socket.on('wheel_place_bet', (data) => {
    if (wheelIsSpinning) return socket.emit('error_message', 'Раунд уже начался!');
    const user = users[socket.userId];
    const amount = Number(data?.amount);
    if (!user || !amount || amount <= 0 || user.stars_balance < amount) return socket.emit('error_message', 'Недостаточно средств!');

    user.stars_balance -= amount;
    const existing = wheelBets.find(b => b.telegram_id === user.telegram_id);
    if (existing) existing.amount += amount;
    else wheelBets.push({ telegram_id: user.telegram_id, name: user.first_name, amount });

    socket.emit('wheel_bet_accepted', { newBalance: user.stars_balance });
    io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
  });

  socket.on('create_table', (data) => {
    const user = users[socket.userId];
    if (!user || user.stars_balance < (data.stake || 10)) return socket.emit('error_message', 'Недостаточно звезд!');

    Object.keys(lobbies).forEach(id => { if (lobbies[id].hostId === user.telegram_id) delete lobbies[id]; });

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    lobbies[tableId] = { id: tableId, hostId: user.telegram_id, hostName: user.first_name, stake: data.stake || 10 };
    socket.emit('table_created', tableId);
    io.emit('lobbies_list', { tables: Object.values(lobbies) });
  });

  socket.on('leave_waiting_table', (tableId) => {
    if (lobbies[tableId]) {
      delete lobbies[tableId];
      socket.emit('table_deleted');
      io.emit('lobbies_list', { tables: Object.values(lobbies) });
    }
  });

  socket.on('join_table', (tableId) => {
    const table = lobbies[tableId];
    const guest = users[socket.userId];
    if (!table || !guest || guest.stars_balance < table.stake) return socket.emit('error_message', 'Ошибка подключения!');

    const host = users[table.hostId];
    host.stars_balance -= table.stake;
    guest.stars_balance -= table.stake;
    delete lobbies[tableId];
    io.emit('lobbies_list', { tables: Object.values(lobbies) });

    const gameId = 'game_' + Math.random().toString(36).substring(2, 9);
    const deck = createDeck(36);
    activeGames[gameId] = {
      id: gameId, stake: table.stake, deck, trumpCard: deck[deck.length - 1], tableCards: [],
      players: [
        { id: host.telegram_id, name: host.first_name, hand: deck.splice(0, 6) },
        { id: guest.telegram_id, name: guest.first_name, hand: deck.splice(0, 6) }
      ],
      attackerIdx: 0, defenderIdx: 1
    };
    broadcastGameState(gameId);
  });

  socket.on('game_action', (data) => {
    const game = activeGames[data.gameId];
    if (!game) return;
    const pIdx = game.players.findIndex(p => p.id === socket.userId);
    if (pIdx === -1) return;

    if (data.action === 'play_card' && pIdx === game.attackerIdx) {
      const hand = game.players[pIdx].hand;
      const card = hand.find(c => c.id === data.cardId);
      if (!card) return;
      hand.splice(hand.indexOf(card), 1);
      game.tableCards.push({ attack: card, defend: null });
      broadcastGameState(data.gameId);
    } else if (data.action === 'bito' && pIdx === game.attackerIdx) {
      game.tableCards = [];
      refillHands(game);
      game.attackerIdx = game.defenderIdx;
      game.defenderIdx = (game.attackerIdx === 0 ? 1 : 0);
      broadcastGameState(data.gameId);
    }
  });

  socket.on('claim_daily', () => {
    const user = users[socket.userId];
    if (!user) return;
    const now = Date.now();
    if (user.last_daily && now - user.last_daily < 86400000) {
      const hoursLeft = Math.ceil((86400000 - (now - user.last_daily)) / 3600000);
      return socket.emit('error_message', `⏰ Бонус доступен через ${hoursLeft} ч.`);
    }
    user.last_daily = now;
    user.stars_balance += 10;
    socket.emit('auth_success', user);
    socket.emit('error_message', '🎁 Бонус получен (+10 ⭐)!');
  });

  socket.on('get_leaderboard', () => {
    socket.emit('leaderboard_data', Object.values(users).sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, 20));
  });
});

function refillHands(game) {
  [game.attackerIdx, game.defenderIdx].forEach(idx => {
    while (game.players[idx].hand.length < 6 && game.deck.length > 0) game.players[idx].hand.push(game.deck.pop());
  });
}

function broadcastGameState(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  io.sockets.sockets.forEach((s) => {
    const pIdx = game.players.findIndex(p => p.id === s.userId);
    if (pIdx === -1) return;
    s.emit('game_state', { gameId: game.id, deckCount: game.deck.length, trumpCard: game.trumpCard, tableCards: game.tableCards });
    s.emit('your_hand', game.players[pIdx].hand);
    s.emit('is_turn_data', { isMyTurn: true, isAttacker: (pIdx === game.attackerIdx) });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CardFool Royal VIP Server running on port ${PORT}`));
