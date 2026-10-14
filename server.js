const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const serviceAccount = require('./firebase-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log('✅ Успешное подключение к Firebase Firestore!');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const onlineUsers = new Set();
const lobbies = {};         
const activeGames = {};     
const friendRequests = {}; 

async function initDefaultQuests() {
  const qRef = db.collection('quests');
  const snapshot = await qRef.get();
  if (snapshot.empty) {
    await qRef.doc('q_1').set({ id: 'q_1', title: 'Сыграть 3 партии в Дурака', target: 3, reward: 15, type: 'play' });
    await qRef.doc('q_2').set({ id: 'q_2', title: 'Выиграть 1 игру', target: 1, reward: 20, type: 'win' });
    console.log('📌 Дефолтные квесты созданы в Firestore.');
  }
}
initDefaultQuests();

setInterval(async () => {
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() === 23 && now.getMinutes() === 59) {
    const usersSnapshot = await db.collection('users').where('weekly_refs', '>', 0).orderBy('weekly_refs', 'desc').get();
    const usersList = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (usersList[0]) {
      const uRef = db.collection('users').doc(usersList[0].id);
      await uRef.update({ stars_balance: (usersList[0].stars_balance || 0) + 50 });
    }
    if (usersList[1]) {
      const uRef = db.collection('users').doc(usersList[1].id);
      await uRef.update({ stars_balance: (usersList[1].stars_balance || 0) + 25 });
    }
    if (usersList[2]) {
      const uRef = db.collection('users').doc(usersList[2].id);
      await uRef.update({ stars_balance: (usersList[2].stars_balance || 0) + 10 });
    }

    const batch = db.batch();
    const allUsers = await db.collection('users').get();
    allUsers.forEach(doc => {
      batch.update(doc.ref, { weekly_refs: 0 });
    });
    await batch.commit();
  }
}, 60000);

const wheelMultipliers = [3, 0.5, 1.5, 0, 2, 0.5, 1.2, 0];
let wheelTimer = 7;
let wheelIsSpinning = false;
let wheelBets = [];

setInterval(async () => {
  if (!wheelIsSpinning) {
    wheelTimer--;
    if (wheelTimer <= 0) {
      wheelIsSpinning = true;
      wheelTimer = 5;

      const winningIndex = Math.floor(Math.random() * 8);
      const targetMultiplier = wheelMultipliers[winningIndex];
      const targetDegree = (7 - winningIndex) * 45 + 22.5;

      for (const bet of wheelBets) {
        const userRef = db.collection('users').doc(bet.telegram_id);
        const userDoc = await userRef.get();
        if (!userDoc.exists) continue;
        const userData = userDoc.data();

        const winAmount = Math.floor(bet.amount * targetMultiplier);
        const newBalance = (userData.stars_balance || 0) + winAmount;
        await userRef.update({ stars_balance: newBalance });

        io.sockets.sockets.forEach((s) => {
          if (s.userId === bet.telegram_id) {
            s.emit('wheel_spin_result', { targetDegree, multiplier: targetMultiplier, winAmount, newBalance });
          }
        });
      }

      io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: true, bets: wheelBets, targetDegree });

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

async function updateQuestProgress(telegramId, type) {
  const userRef = db.collection('users').doc(telegramId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return;
  const userData = userDoc.data();

  const questsSnapshot = await db.collection('quests').where('type', '==', type).get();
  let questProgress = userData.quest_progress || {};
  let claimedQuests = userData.claimed_quests || [];

  let updated = false;
  questsSnapshot.forEach(doc => {
    const q = doc.data();
    if (!claimedQuests.includes(q.id)) {
      const current = questProgress[q.id] || 0;
      if (current < q.target) {
        questProgress[q.id] = current + 1;
        updated = true;
      }
    }
  });

  if (updated) {
    await userRef.update({ quest_progress: questProgress });
  }
}
io.on('connection', (socket) => {
  socket.on('auth', async (data) => {
    const { telegram_id, username, first_name, photo_url, refId } = data;
    if (!telegram_id) return;

    const tgIdStr = String(telegram_id);
    const newUniqueId = tgIdStr.slice(0, 6);
    const userRef = db.collection('users').doc(tgIdStr);
    const userDoc = await userRef.get();

    let userData;
    if (!userDoc.exists) {
      userData = {
        telegram_id: tgIdStr,
        username: username || 'Игрок',
        first_name: first_name || 'Игрок',
        photo_url: photo_url || '',
        stars_balance: 0, 
        wins: 0, 
        losses: 0,
        unique_id: newUniqueId,
        referrer_id: null,
        referral_count: 0,
        weekly_refs: 0,
        friends: [],
        activated_promos: [],
        claimed_quests: [],
        quest_progress: {},
        last_daily: 0
      };
      await userRef.set(userData);

      if (refId && refId !== newUniqueId && refId !== tgIdStr) {
        const refQuery = await db.collection('users').where('unique_id', '==', refId).limit(1).get();
        if (!refQuery.empty) {
          const refDoc = refQuery.docs[0];
          const refData = refDoc.data();
          const refRef = refDoc.ref;

          userData.referrer_id = refData.unique_id;
          await userRef.update({ referrer_id: refData.unique_id });

          let newBal = (refData.stars_balance || 0) + 10;
          let newRefCnt = (refData.referral_count || 0) + 1;
          let newWeeklyRefs = (refData.weekly_refs || 0) + 1;

          if (newRefCnt === 3) newBal += 12;
          if (newRefCnt === 10) newBal += 25;
          if (newRefCnt === 25) newBal += 75;
          if (newRefCnt === 50) newBal += 250;

          await refRef.update({
            stars_balance: newBal,
            referral_count: newRefCnt,
            weekly_refs: newWeeklyRefs
          });
        }
      }
    } else {
      userData = userDoc.data();
      userData.unique_id = newUniqueId;
      userData.username = username || userData.username;
      userData.first_name = first_name || userData.first_name;
      userData.photo_url = photo_url || userData.photo_url;
      await userRef.update({
        unique_id: newUniqueId,
        username: userData.username,
        first_name: userData.first_name,
        photo_url: userData.photo_url
      });
    }

    socket.userId = tgIdStr;
    onlineUsers.add(tgIdStr);

    socket.emit('auth_success', userData);
    socket.emit('lobbies_list', { tables: Object.values(lobbies) });

    const tourSnapshot = await db.collection('tournaments').get();
    socket.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
    socket.emit('friend_requests_update', friendRequests[tgIdStr] || []);

    socket.on('disconnect', () => {
      if (socket.userId) onlineUsers.delete(socket.userId);
    });
  });

  socket.on('admin_create_tournament', async (data) => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const uData = userDoc.data();
    if (!uData.telegram_id.startsWith('186601') && uData.unique_id !== '186601') return;

    const prize = (data.prizeType === 'fixed') ? data.fixedPrize : Math.floor(data.stake * data.players * 0.9);
    const tourId = 'tour_' + Date.now();
    const tourObj = {
      id: tourId,
      title: data.title,
      maxPlayers: data.players,
      mode: data.mode,
      deckSize: data.deckSize,
      stake: data.stake,
      prize,
      joined: [],
      joinedCount: 0
    };

    await db.collection('tournaments').doc(tourId).set(tourObj);
    const tourSnapshot = await db.collection('tournaments').get();
    io.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
  });

  socket.on('admin_create_quest', async (data) => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const uData = userDoc.data();
    if (!uData.telegram_id.startsWith('186601') && uData.unique_id !== '186601') return;

    const qId = 'q_' + Date.now();
    await db.collection('quests').doc(qId).set({
      id: qId,
      title: data.title,
      target: data.target,
      reward: data.reward,
      type: 'play'
    });

    const questsSnap = await db.collection('quests').get();
    io.emit('daily_quests_data', questsSnap.docs.map(doc => ({ ...doc.data(), progress: 0, claimed: false })));
  });

  socket.on('get_daily_quests', async () => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const questsSnap = await db.collection('quests').get();
    const questProgress = userData.quest_progress || {};
    const claimedQuests = userData.claimed_quests || [];

    const questsData = questsSnap.docs.map(doc => {
      const q = doc.data();
      return {
        ...q,
        progress: questProgress[q.id] || 0,
        claimed: claimedQuests.includes(q.id)
      };
    });
    socket.emit('daily_quests_data', questsData);
  });

  socket.on('claim_quest', async (questId) => {
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    const questDoc = await db.collection('quests').doc(questId).get();
    if (!userDoc.exists || !questDoc.exists) return;

    const userData = userDoc.data();
    const qData = questDoc.data();
    let claimedQuests = userData.claimed_quests || [];

    if (claimedQuests.includes(questId)) return socket.emit('error_message', 'Награда уже получена!');

    const questProgress = userData.quest_progress || {};
    const currentProgress = questProgress[questId] || 0;

    if (currentProgress < qData.target) {
      return socket.emit('error_message', `Задание еще не выполнено! (${currentProgress}/${qData.target})`);
    }

    claimedQuests.push(questId);
    const newBalance = (userData.stars_balance || 0) + qData.reward;

    await userRef.update({
      claimed_quests: claimedQuests,
      stars_balance: newBalance
    });

    const updatedUserDoc = await userRef.get();
    socket.emit('auth_success', updatedUserDoc.data());
    socket.emit('error_message', `🎉 Задание выполнено! Начислено +${qData.reward} ⭐`);

    const questsSnap = await db.collection('quests').get();
    const updatedQuestsData = questsSnap.docs.map(doc => {
      const q = doc.data();
      return {
        ...q,
        progress: (updatedUserDoc.data().quest_progress || {})[q.id] || 0,
        claimed: updatedUserDoc.data().claimed_quests.includes(q.id)
      };
    });
    socket.emit('daily_quests_data', updatedQuestsData);
  });

  socket.on('get_tournaments', async () => {
    const tourSnapshot = await db.collection('tournaments').get();
    socket.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
  });

  socket.on('join_tournament', async (tourId) => {
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    const tourRef = db.collection('tournaments').doc(tourId);
    const tourDoc = await tourRef.get();

    if (!userDoc.exists || !tourDoc.exists) return;
    const userData = userDoc.data();
    const tourData = tourDoc.data();

    if (tourData.joined.includes(userData.telegram_id)) return socket.emit('error_message', 'Вы уже зарегистрированы!');
    if (tourData.joinedCount >= tourData.maxPlayers) return socket.emit('error_message', 'Турнир полон!');
    if ((userData.stars_balance || 0) < tourData.stake) return socket.emit('error_message', 'Недостаточно звезд!');

    const newBal = userData.stars_balance - tourData.stake;
    await userRef.update({ stars_balance: newBal });

    tourData.joined.push(userData.telegram_id);
    tourData.joinedCount++;
    await tourRef.update({ joined: tourData.joined, joinedCount: tourData.joinedCount });

    const freshUserDoc = await userRef.get();
    socket.emit('auth_success', freshUserDoc.data());
    
    const tourSnapshot = await db.collection('tournaments').get();
    io.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
    socket.emit('error_message', 'Вы успешно вступили в турнир!');
  });
