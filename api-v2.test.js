import http from 'k6/http';
import { check, fail } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const bets = new SharedArray('bets', function () {
  return JSON.parse(open('./bets.json'));
});

const CH_LOCAL = __ENV.CH_LOCAL;
const LAUNCH_TOKEN = __ENV.LAUNCH_TOKEN;

const playerTokens = {};

export const options = {
  scenarios: {
    bets_flow: {
      executor: 'shared-iterations',
      vus: 3,
      iterations: bets.length,
      maxDuration: '30m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

function getPlayerToken(playerId) {
  if (playerTokens[playerId]) {
    return playerTokens[playerId];
  }

  const launchUrl = `${CH_LOCAL}/launch/${playerId}?token=${LAUNCH_TOKEN}`;
  const res = http.get(launchUrl);

  const ok = check(res, {
    'launch status 200': (r) => r.status === 200,
    'launch token exists': (r) => !!r.json('content.token'),
  });

  if (!ok) {
    fail(`No se pudo obtener token para playerId=${playerId}. Status=${res.status} Body=${res.body}`);
  }

  const token = res.json('content.token');
  playerTokens[playerId] = token;
  return token;
}

export default function () {
  const bet = bets[exec.scenario.iterationInTest];

  const token = getPlayerToken(bet.playerId);

  const payload = JSON.stringify({
    amount: bet.amount,
    amountTimes: bet.amountTimes,
    entryRacecourseId: bet.entryRacecourseId,
    racecourseRaceId: bet.racecourseRaceId,
    combination: bet.combination,
    token,
  });

  const res = http.post(`${CH_LOCAL}/bets`, payload, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  console.log('ESTATUS: ', res.status_text);

  console.log('BODY: ', res.body);

  check(res, {
    [`bet status ${bet.expectedStatus}`]: (r) => r.status === bet.expectedStatus,
  });
}