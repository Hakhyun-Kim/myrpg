// 경제 시뮬레이션 실행기: npm run sim -- --bots 20 --days 7 --seed 42
import { formatReport, runSimulation } from "./sim.js";

const args = process.argv.slice(2);
function arg(name: string, def: number): number {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : def;
}

const report = runSimulation({
  bots: arg("bots", 20),
  days: arg("days", 7),
  seed: arg("seed", 42),
});
console.log(formatReport(report));
