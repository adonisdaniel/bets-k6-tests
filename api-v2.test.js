import http from "k6/http";
import { check, fail, sleep } from "k6";
import { SharedArray } from "k6/data";
import { URL } from "https://jslib.k6.io/url/1.0.0/index.js";
import exec from "k6/execution";

const CH_LOCAL = __ENV.CH_LOCAL;
const LAUNCH_TOKEN = __ENV.LAUNCH_TOKEN;

const SLEEP_BETWEEN = Number(__ENV.SLEEP_BETWEEN || 0.3);
const SLEEP_ITERATION = Number(__ENV.SLEEP_ITERATION || 1.5);

const players = new SharedArray("players", () =>
  JSON.parse(open("./players.json")),
);

export const options = {
  scenarios: {
    bets_flow: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 1),
      iterations: Number(__ENV.ITERATIONS || players.length),
      maxDuration: __ENV.MAX_DURATION || "30m",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],
  },
};

const playerTokens = {};

function getJson(url, headers = {}) {
  const res = http.get(url, { headers });
  return res;
}

function getLaunchToken(playerId) {
  if (playerTokens[playerId]) return playerTokens[playerId];

  const url = `${CH_LOCAL}/launch/${playerId}?token=${LAUNCH_TOKEN}`;
  const res = getJson(url);

  if (res.error || res.status === 0) {
    fail(
      `launch connection failed for playerId=${playerId}: ${res.error || "unknown error"}`,
    );
  }

  check(res, {
    "launch status 200": (r) => r.status === 200,
    "launch token exists": (r) => !!r.json("content.token"),
  });

  if (res.status !== 200) {
    fail(
      `launch failed for playerId=${playerId}: status=${res.status} body=${res.body}`,
    );
  }

  const token = res.json("content.token");
  if (!token) {
    fail(`launch token missing for playerId=${playerId}`);
  }

  playerTokens[playerId] = token;
  return token;
}

function getSessionByToken(token) {
  const url = `${CH_LOCAL}/auth/session/player-by-token`;
  const res = http.get(url, {
    headers: {
      "x-token": token,
    },
  });

  check(res, {
    "session status 200": (r) => r.status === 200,
    "session player id exists": (r) => !!r.json("id"),
    "session client id exists": (r) => !!r.json("clientId"),
    "session currency id exists": (r) => !!r.json("currencyId"),
  });

  if (res.status !== 200) {
    fail(`session failed: status=${res.status} body=${res.body}`);
  }

  return res.json();
}

function getRacecourseTypeId() {
  const url = `${CH_LOCAL}/racecourse-types`;
  const res = http.get(url);

  check(res, {
    "racecourse-types status 200": (r) => r.status === 200,
    "racecourse-types has data": (r) =>
      Array.isArray(r.json("data")) && r.json("data").length > 0,
  });

  if (res.status !== 200) {
    fail(`racecourse-types failed: status=${res.status} body=${res.body}`);
  }

  const data = res.json("data") || [];
  const horseType = data.find(
    (x) => String(x.name || "").toLowerCase() === "caballos",
  );

  if (!horseType) {
    fail(`racecourse type "caballos" not found`);
  }

  return horseType.id;
}

function getUpcomingRaces(clientId, racecourseTypeId) {
  const url = new URL(`${CH_LOCAL}/racecourses-races/races-from-now-by-client`);
  url.searchParams.set("client", clientId);
  url.searchParams.set("racecourseTypeId", racecourseTypeId);
  url.searchParams.set("date", new Date().toISOString());

  const res = http.get(url.toString());

  check(res, {
    "upcoming races status 200": (r) => r.status === 200,
    "upcoming races has data": (r) =>
      Array.isArray(r.json()) && r.json().length > 0,
  });

  if (res.status !== 200) {
    fail(`upcoming races failed: status=${res.status} body=${res.body}`);
  }

  const races = res.json();
  if (!Array.isArray(races) || !races.length) {
    fail(`upcoming races empty`);
  }

  return races;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getValidHorses(horses) {
  return horses.filter(
    (h) =>
      h &&
      h.available === true &&
      h.status === true &&
      h.horse &&
      h.horse.status === true &&
      h.letter != null,
  );
}

function getMinBet(pool) {
  const raw =
    pool?.limits?.minBet ??
    pool?.limits?.min_bet ??
    pool?.unityCount?.min_count ??
    4;

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    return 4;
  }

  return value;
}

function sumFromMatchGroups(str) {
  const segments = String(str).split("/").filter(Boolean);
  let total = 0;

  for (const seg of segments) {
    const parts = seg.split("-").filter(Boolean);

    if (parts.length >= 4) {
      total +=
        Number(parts[1] || 0) + Number(parts[2] || 0) + Number(parts[3] || 0);
    } else if (parts.length === 3) {
      total += Number(parts[1] || 0) + Number(parts[2] || 0);
    } else if (parts.length === 2) {
      total += Number(parts[1] || 0);
    }
  }

  return total;
}

function buildCombination(pool, horses) {
  const name = String(pool?.name || "").toLowerCase();
  const valid = getValidHorses(horses);
  const letters = shuffle(valid.map((h) => String(h.letter)));

  if (name === "exacta") {
    if (letters.length < 2) return null;
    return {
      combination: `${letters[0]}/${letters[1]}/exacta`,
      amount: getMinBet(pool),
      unity: 1,
    };
  }

  if (name === "trifecta") {
    if (letters.length < 3) return null;
    return {
      combination: `${letters[0]}/${letters[1]}/${letters[2]}/trifecta`,
      amount: getMinBet(pool),
      unity: 1,
    };
  }

  if (name === "superfecta") {
    if (letters.length < 4) return null;
    return {
      combination: `${letters[0]}/${letters[1]}/${letters[2]}/${letters[3]}/superfecta`,
      amount: getMinBet(pool),
      unity: 1,
    };
  }

  if (name === "win") {
    if (letters.length < 1) return null;
    const amount = getMinBet(pool);
    return {
      combination: `${letters[0]}-${amount}-0/wp`,
      amount,
    };
  }

  if (name === "place") {
    if (letters.length < 1) return null;
    const amount = getMinBet(pool);
    return {
      combination: `${letters[0]}-0-${amount}/wp`,
      amount,
    };
  }

  if (name === "wps") {
    if (letters.length < 1) return null;
    const amount = getMinBet(pool);
    const count = Math.min(2, letters.length);
    const segments = [];

    for (let i = 0; i < count; i++) {
      segments.push(`${letters[i]}-${amount}-${amount}-${amount}`);
    }

    const combination = `${segments.join("/")}/wps`;
    return {
      combination,
      amount: sumFromMatchGroups(combination),
    };
  }

  return null;
}

function getPickLimit(poolName) {
  const limits = { 'pick 2': 2, 'pick 3': 3, 'pick 4': 4, 'pick 5': 5 };
  return limits[poolName] ?? null;
}

function buildPickLegSelection(leg, maxSelections = 1) {
  const available = leg.filter((h) => h.available && h.status && h.letter);
  if (!available.length) throw new Error('No available horses in pick leg');
  const shuffled = shuffle(available);
  return shuffled.slice(0, maxSelections).map((h) => h.letter).join('-');
}

function buildPickCombinationFromLegs(pickLegs, poolName) {
  const legSelections = pickLegs.map((leg) => {
    const available = leg.filter((h) => h.available && h.status && h.letter);
    if (available.length < 2) throw new Error('Not enough available horses in pick leg');
    const selections = Math.floor(Math.random() * (available.length - 1)) + 2;
    return buildPickLegSelection(leg, selections);
  });

  return `${legSelections.join('/')}/${poolName}`;
}

function buildPickBetPayload(baseRaceId, poolName, token) {
  const limit = getPickLimit(poolName);
  if (!limit) throw new Error(`Unsupported pick pool: ${poolName}`);

  const url = `${CH_LOCAL}/racecourses-races/${baseRaceId}/get-races-limit?limit=${limit}`;
  const res = http.get(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${token}`,
    },
  });

  check(res, {
    [`${poolName} status 200`]: (r) => r.status === 200,
    [`${poolName} has legs`]: (r) => Array.isArray(r.json()),
  });

  if (res.status !== 200) {
    fail(`${poolName} failed: status=${res.status} body=${res.body}`);
  }

  const pickLegs = res.json() || [];
  if (!Array.isArray(pickLegs) || pickLegs.length !== limit) {
    fail(`${poolName} invalid legs response`);
  }

  const combination = buildPickCombinationFromLegs(pickLegs, poolName);

  return {
    amount: 4,
    amountTimes: 1,
    combination,
    unity: 1,
  };
}

function getRaceData(racesPayload) {
  const flatRaces = [];

  for (const entry of racesPayload) {
    if (!entry || !Array.isArray(entry.races)) continue;
    for (const race of entry.races) {
      if (race && race.id && race.entryRacecourseId) {
        flatRaces.push({
          racecourseRaceId: race.id,
          entryRacecourseId: race.entryRacecourseId,
          meta: entry,
          race,
        });
      }
    }
  }

  return flatRaces;
}

export default function () {
  const player = players[exec.scenario.iterationInTest % players.length];
  const playerId = player.playerId || player.id;

  if (!playerId) fail("playerId missing in players.json");

  const launchToken = getLaunchToken(playerId);
  sleep(SLEEP_BETWEEN);

  const session = getSessionByToken(launchToken);
  sleep(SLEEP_BETWEEN);

  console.log("session", session.username);

  const racecourseTypeId = getRacecourseTypeId();
  sleep(SLEEP_BETWEEN);

  const racesPayload = getUpcomingRaces(session.clientId, racecourseTypeId);
  sleep(SLEEP_BETWEEN);

  const races = getRaceData(racesPayload);

  if (!races.length) {
    fail("no races available");
  }

  const chosenRace = pickRandom(races);

  console.log("race", chosenRace.racecourseRaceId);

  const horsesUrl = new URL(
    `${CH_LOCAL}/racecourses-races/${chosenRace.racecourseRaceId}/horses`,
  );
  horsesUrl.searchParams.set("client_id", session.clientId);
  horsesUrl.searchParams.set("currency_id", session.currencyId);
  horsesUrl.searchParams.set("player_id", session.id);

  const horsesRes = http.get(horsesUrl.toString());

  check(horsesRes, {
    "horses status 200": (r) => r.status === 200,
    "horses has racePools": (r) => Array.isArray(r.json("racePools")),
    "horses has horses": (r) => Array.isArray(r.json("horses")),
  });

  if (horsesRes.status !== 200) {
    fail(`horses failed: status=${horsesRes.status} body=${horsesRes.body}`);
  }

  const racePools = horsesRes.json("racePools") || [];
  const horses = horsesRes.json("horses") || [];

  console.log("racePools", racePools.length, "horses", horses.length);
  sleep(SLEEP_BETWEEN);

  const supportedPools = racePools.filter((p) =>
    [
      "win",
      "place",
      "exacta",
      "trifecta",
      "superfecta",
      "wps",
      "pick 2",
      "pick 3",
      "pick 4",
      "pick 5",
    ].includes(String(p.name || "").toLowerCase()),
  );

  if (!supportedPools.length) {
    fail(
      `no supported race pools available for racecourseRaceId=${chosenRace.racecourseRaceId}`,
    );
  }

  let betPayload = null;
  let selectedPool = null;

  const shuffledPools = shuffle(supportedPools);

  for (const pool of shuffledPools) {
    const poolName = String(pool.name || "").toLowerCase();

    let built = null;

    if (getPickLimit(poolName)) {
      built = buildPickBetPayload(
        chosenRace.racecourseRaceId,
        poolName,
        launchToken,
      );
    } else {
      built = buildCombination(pool, horses);
    }

    if (built) {
      betPayload = built;
      selectedPool = pool;
      break;
    }
  }

  if (!betPayload) {
    fail(
      `could not build a valid combination for racecourseRaceId=${chosenRace.racecourseRaceId}`,
    );
  }

  const dataBet = {
    amount: betPayload.amount,
    amountTimes: 1,
    combination: betPayload.combination,
    entryRacecourseId: chosenRace.entryRacecourseId,
    racecourseRaceId: chosenRace.racecourseRaceId,
    token: launchToken,
  };

  if (betPayload.unity) Object.assign(dataBet, { unity: betPayload.unity });

  const betRes = http.post(`${CH_LOCAL}/bets`, JSON.stringify(dataBet), {
    headers: {
      "Content-Type": "application/json",
    },
  });

  console.log("betPayload", betPayload);

  check(betRes, {
    "bet status 200": (r) => r.status === 200,
  });

  if (betRes.status !== 200) {
    console.log(
      JSON.stringify({
        playerId,
        racecourseRaceId: chosenRace.racecourseRaceId,
        pool: selectedPool?.name,
        payload: betPayload,
        status: betRes.status,
        body: betRes.body,
      }),
    );
  }

  sleep(SLEEP_ITERATION);
}
