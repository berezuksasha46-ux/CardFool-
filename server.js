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
