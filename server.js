const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const users = {};           
const uniqueIdToTgId = {};  
const lobbies = {};         
const activeGames = {};     

// --- КОЛЕСО ФОРТУНЫ (ТОЧНАЯ СИНХРОНИЗАЦИЯ СЕКТОРОВ) ---
let wheelTimer = 7;
let wheelIsSpinning = false;
let wheelBets = [];

setInterval(() => {
  if (!wheelIsSpinning) {
    wheelTimer--;
    if (wheelTimer <= 0) {
      wheelIsSpinning = true;
      wheelTimer = 5;

      const multipliers = [3, 0.5, 1.5, 0, 2, 0.5, 1.2, 0];
      const winningIndex = Math.floor(Math.random() * 8);
      const targetMultiplier = multipliers[winningIndex];
      const targetDegree = (7 - winningIndex) * 45 + 22.5;

      wheelBets.forEach((bet) => {
        const player = users[bet.telegram_id];
        if (!player) return;

        const winAmount = Math.floor(bet.amount * targetMultiplier);
        player.stars_balance += winAmount;

        io.sockets.sockets.forEach((s) => {
          if (s.userId === player.telegram_id) {
            s.emit('wheel_spin_result', {
              targetDegree,
              multiplier: targetMultiplier,
              winAmount,
              newBalance: player.stars_balance
            });
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

  suits.forEach(suit => {
    allRanks.forEach(rank => {
      deck.push({ id: 'c_' + (idCounter++), suit, rank });
    });
  });

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
        stars_balance: 0, // Баланс при первом входе строго 0
        wins: 0,
        losses: 0,
        unique_id: newUniqueId,
        referrer_id: null,
        referral_count: 0,
        referral_earned: 0,
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
          referrer.referral_count += 1;
          referrer.referral_earned += 10;
        }
      }
    } else {
      user.username = username || user.username;
      user.first_name = first_name || user.first_name;
      user.photo_url = photo_url || user.photo_url;
    }

    socket.userId = user.telegram_id;
    socket.emit('auth_success', user);
    socket.emit('lobbies_list', { tables: Object.values(lobbies) });
  });

  socket.on('get_friends', () => {
    if (!socket.userId) return;
    const user = users[socket.userId];
    if (!user) return;
    const myReferrals = Object.values(users).filter(u => u.referrer_id === user.unique_id);
    socket.emit('friends_list', { friends: myReferrals, referralCount: user.referral_count, referralEarned: user.referral_earned });
  });

  socket.on('wheel_place_bet', (data) => {
    if (wheelIsSpinning) return socket.emit('error_message', 'Раунд уже начался!');
    const user = users[socket.userId];
    const amount = Number(data?.amount);

    if (!user || !amount || amount <= 0) return socket.emit('error_message', 'Некорректная сумма!');
    if (user.stars_balance < amount) return socket.emit('error_message', 'Недостаточно звезд!');

    user.stars_balance -= amount;
    const existing = wheelBets.find(b => b.telegram_id === user.telegram_id);
    if (existing) existing.amount += amount;
    else wheelBets.push({ telegram_id: user.telegram_id, name: user.first_name || user.username || 'Игрок', amount });

    socket.emit('wheel_bet_accepted', { newBalance: user.stars_balance });
    io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
  });

  socket.on('get_lobbies', () => { socket.emit('lobbies_list', { tables: Object.values(lobbies) }); });

  socket.on('create_table', (data) => {
    const user = users[socket.userId];
    if (!user) return;
    if (user.stars_balance < data.stake) return socket.emit('error_message', 'Недостаточно звезд!');

    Object.keys(lobbies).forEach(id => { if (lobbies[id].hostId === user.telegram_id) delete lobbies[id]; });

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    lobbies[tableId] = { id: tableId, hostId: user.telegram_id, hostName: user.first_name || user.username, mode: data.mode || 'podkidnoy', deckSize: data.deckSize || 36, stake: data.stake || 10 };

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
    if (!table || !guest) return;
    if (guest.stars_balance < table.stake) return socket.emit('error_message', 'Недостаточно средств!');

    const host = users[table.hostId];
    if (!host) return;

    host.stars_balance -= table.stake;
    guest.stars_balance -= table.stake;
    delete lobbies[tableId];
    io.emit('lobbies_list', { tables: Object.values(lobbies) });

    const gameId = 'game_' + Math.random().toString(36).substring(2, 9);
    const deck = createDeck(table.deckSize);
    const trumpCard = deck[deck.length - 1];

    activeGames[gameId] = {
      id: gameId,
      stake: table.stake,
      deck,
      trumpCard,
      tableCards: [],
      players: [
        { id: host.telegram_id, name: host.first_name, photoUrl: host.photo_url, hand: deck.splice(0, 6) },
        { id: guest.telegram_id, name: guest.first_name, photoUrl: guest.photo_url, hand: deck.splice(0, 6) }
      ],
      attackerIdx: 0,
      defenderIdx: 1
    };

    broadcastGameState(gameId);
  });
