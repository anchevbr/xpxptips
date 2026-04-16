import type { CommentaryStatLine } from '../utils/commentary';

export interface FakeStat extends CommentaryStatLine {}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function isBasketballLeague(league: string): boolean {
  const normalized = league.toLowerCase();
  return (
    normalized.includes('euroleague') ||
    normalized.includes('nba') ||
    normalized.includes('basketball') ||
    normalized.includes('euroliga')
  );
}

export function randomFootballStats(): FakeStat[] {
  const homePossession = rand(38, 65);
  return [
    { strStat: 'Shots on Goal', intHome: String(rand(3, 10)), intAway: String(rand(2, 8)) },
    { strStat: 'Shots off Goal', intHome: String(rand(2, 7)), intAway: String(rand(1, 6)) },
    { strStat: 'Total Shots', intHome: String(rand(8, 20)), intAway: String(rand(5, 16)) },
    { strStat: 'Ball Possession', intHome: String(homePossession), intAway: String(100 - homePossession) },
    { strStat: 'Corner Kicks', intHome: String(rand(2, 9)), intAway: String(rand(1, 7)) },
    { strStat: 'Fouls', intHome: String(rand(6, 16)), intAway: String(rand(5, 15)) },
    { strStat: 'Yellow Cards', intHome: String(rand(0, 3)), intAway: String(rand(0, 3)) },
    { strStat: 'Offsides', intHome: String(rand(0, 5)), intAway: String(rand(0, 4)) },
    { strStat: 'Goalkeeper Saves', intHome: String(rand(2, 6)), intAway: String(rand(2, 8)) },
    { strStat: 'expected_goals', intHome: `${rand(0, 2)}.${rand(0, 9)}`, intAway: `${rand(0, 1)}.${rand(0, 9)}` },
  ];
}

export function randomBasketballStats(): FakeStat[] {
  return [
    { strStat: 'Field Goals %', intHome: String(rand(40, 58)), intAway: String(rand(38, 55)) },
    { strStat: '3 Points %', intHome: String(rand(28, 45)), intAway: String(rand(25, 43)) },
    { strStat: 'Free Throws %', intHome: String(rand(65, 90)), intAway: String(rand(60, 88)) },
    { strStat: 'Rebounds', intHome: String(rand(30, 50)), intAway: String(rand(28, 48)) },
    { strStat: 'Assists', intHome: String(rand(12, 28)), intAway: String(rand(10, 26)) },
    { strStat: 'Turnovers', intHome: String(rand(6, 18)), intAway: String(rand(6, 18)) },
    { strStat: 'Steals', intHome: String(rand(4, 12)), intAway: String(rand(4, 12)) },
    { strStat: 'Blocks', intHome: String(rand(2, 8)), intAway: String(rand(2, 8)) },
  ];
}