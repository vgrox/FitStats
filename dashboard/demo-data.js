// Deterministic fixtures. All values are generated without reading local files or APIs.
const sessions = [
  { type: "Run", name: "Easy run", km: 5, speed: 9.5, elevation: 35, heartRate: 146 },
  { type: "Ride", name: "Endurance ride", km: 23, speed: 23, elevation: 145, heartRate: 131 },
  { type: "Run", name: "Tempo run", km: 7, speed: 11.2, elevation: 54, heartRate: 159 },
  { type: "Walk", name: "Recovery walk", km: 4, speed: 5, elevation: 24, heartRate: 105 },
  { type: "Ride", name: "Weekend ride", km: 34, speed: 21, elevation: 220, heartRate: 139 },
  { type: "Run", name: "Long run", km: 9, speed: 9.1, elevation: 70, heartRate: 150 }
];

export const demoActivities = Array.from({ length: 26 * 3 }, (_, index) => {
  const week = Math.floor(index / 3);
  const session = sessions[index % sessions.length];
  const date = new Date(Date.UTC(2025, 0, 6 + week * 7 + [1, 3, 6][index % 3], 7)).toISOString();
  const recovery = week % 4 === 3 ? 0.75 : 1;
  const km = Math.round(session.km * (1 + week * 0.014) * recovery * 10) / 10;
  const seconds = Math.round(km / (session.speed + (week % 5) * 0.2) * 3600);
  return {
    id: index + 1, name: session.name, type: session.type, date, localDate: date,
    km, seconds, elapsed: seconds + index % 7 * 30,
    speed: km * 3600 / seconds, pace: seconds / km / 60,
    elevation: Math.round(session.elevation * km / session.km),
    heartRate: session.heartRate + index % 9 - 4
  };
});

export function demoDetail(id) {
  const workout = demoActivities.find(activity => activity.id === id);
  if (!workout) throw new Error("Sample workout could not be found.");
  const progress = Array.from({ length: 21 }, (_, index) => index / 20);
  return {
    summary: {
      name: workout.name, sport_type: workout.type, start_date: workout.date,
      distance_m: workout.km * 1000, moving_time_s: workout.seconds,
      elapsed_time_s: workout.elapsed, total_elevation_gain_m: workout.elevation,
      average_heartrate_bpm: workout.heartRate
    },
    raw: { description: "Synthetic workout generated for the FitStats demo." },
    streams: {
      time: { data: progress.map(fraction => Math.round(workout.seconds * fraction)) },
      distance: { data: progress.map(fraction => Math.round(workout.km * 1000 * fraction)) },
      heartrate: { data: progress.map(fraction =>
        workout.heartRate + Math.round(8 * Math.sin(fraction * 4 * Math.PI))) }
    }
  };
}
