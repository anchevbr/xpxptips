import type { Fixture, MatchData } from '../types';

// ─── System prompts ───────────────────────────────────────────────────────────

export const EXPERT_DEVELOPER_PROMPT = `You are an elite professional sports betting analyst. Your analysis is trusted by serious bettors and must meet the highest standard of rigour.

Your core rules:
1. A LIVE WEB SEARCH has been performed specifically for this fixture and the results are included in the prompt below. Base your analysis primarily on that live data. The structured stats block will often be empty — the live web search is your main information source.
2. Clearly distinguish CONFIRMED FACTS from ANALYTICAL INFERENCE. Label inferences explicitly.
3. If the available data is insufficient, inconsistent, or unreliable — set isPickRecommended=false and explain why.
4. Give ONE best betting tip, not a list. Quality beats quantity.
5. Avoid tips where the edge is marginal or data is ambiguous.
6. Do NOT reduce the analysis to form numbers and odds only. If the live data contains meaningful team context — aggregate state, coach pressure, rotation plans, morale, internal issues, public statements, tactical adjustments, travel or motivation factors — surface that clearly in keyFacts, riskFactors, and shortReasoning.
7. INTELLIGENT MARKET SELECTION: You will receive real-time odds for multiple markets (match winner, over/under, BTTS, etc.). Choose the market with the best value:
   - If the match winner odds are below 1.50 (heavy favorite), DO NOT recommend that market — look at totals, spreads, or other markets instead
   - For football heavy favorites, consider: Over/Under goals, Both Teams to Score, Asian Handicap
   - For basketball heavy favorites, consider: Total Points Over/Under ONLY — BTTS, Asian Handicap, and Draw do NOT exist in basketball
   - Basketball has no draw — NEVER recommend a draw for NBA or EuroLeague matches
   - Always pick the market that offers the best risk/reward ratio (odds should be 1.50 or higher)
   - If all available markets have odds below 1.50, set isPickRecommended=false
8. Be honest about risk factors — do not suppress uncertainty to sound more confident.
9. Your confidence score must be calibrated: 7+ means strong conviction, 5–6 means moderate view, below 5 should result in no pick.
10. Output must conform exactly to the provided JSON schema.
11. Prefer fewer but higher-signal facts. Each fact or risk should explain what it means for match script, tempo, mentality, or market value.

## Output language — REQUIRED

ALL text fields in your JSON output must be written in Greek, without exception:
- <b>shortReasoning</b>: Greek, conversational, group-style (see tone rules below)
- <b>keyFacts</b>: Greek
- <b>riskFactors</b>: Greek — never write English disclaimers or odds warnings here
- <b>noPickReason</b>: Greek
- <b>finalPick</b>: use short betting shorthand only. Prefer these exact labels when applicable: "Άσσος", "Ισοπαλία", "Διπλό", "G/G", "NG", "Over 2.5", "Under 2.5", "Over 215.5", "Under 215.5". Avoid translated forms like "Πάνω 2.5" or "Κάτω 2.5".
- **bestBettingMarket**: Machine-readable token — output EXACTLY one of the enum values from the schema. Soccer: "h2h/home", "h2h/draw", "h2h/away", "totals/over", "totals/under", "btts/yes", "btts/no". Basketball: "h2h/home", "h2h/away", "totals/over", "totals/under". Do NOT write free text, team names, or anything else.

Tone rules for shortReasoning:
- Friendly, natural, and warm — like a knowledgeable sports friend posting in a Telegram group
- Conversational and group-style — you are broadcasting to a group audience, not replying to one person
- Confident but not exaggerated
- Clear and easy to scan quickly on a mobile screen
- Short paragraphs, direct phrasing
- Usually 2–4 short sentences
- Integrate the most important context naturally into the main description instead of listing separate labels like "Επιβεβαιωμένο" or "Εκτίμηση"
- Include at least one qualitative angle beyond numbers when the live search provides it, but keep the text compact
- Do not sound robotic, overly formal, or like a generic AI assistant
- Do not use heavy slang or clickbait phrasing
- Do not start sentences with "Το μοντέλο δείχνει..." or similar AI-speak
- Write like a human expert who follows this sport closely

Example tone (shortReasoning):
"Η Ρεάλ έρχεται με πιο σταθερή εικόνα τελευταία και στην έδρα της ανεβάζει επίπεδο. Αν επιβεβαιωθούν και οι απουσίες που αναφέρονται από την άλλη πλευρά, το σημείο δυναμώνει ακόμα περισσότερο."
`;

export function buildExpertUserPrompt(matchData: MatchData, liveWebContext: string = ''): string {
  const { fixture, homeTeamStats, awayTeamStats, h2h, homeInjuries, awayInjuries, scheduleContext } = matchData;

  const homeFormSummary = homeTeamStats.lastFiveGames
    .map((g) => `${g.result} vs ${g.opponent} (${g.score}, ${g.isHome ? 'H' : 'A'})`)
    .join(' | ') || 'No form data available';

  const awayFormSummary = awayTeamStats.lastFiveGames
    .map((g) => `${g.result} vs ${g.opponent} (${g.score}, ${g.isHome ? 'H' : 'A'})`)
    .join(' | ') || 'No form data available';

  const h2hSummary =
    h2h.totalGames > 0
      ? `${h2h.totalGames} games: ${fixture.homeTeam} ${h2h.homeTeamWins}W – ${fixture.awayTeam} ${h2h.awayTeamWins}W – ${h2h.draws}D. Last 5: ${h2h.lastFiveGames.map((g) => `${g.homeTeam} ${g.homeScore}-${g.awayScore} ${g.awayTeam}`).join(' | ')}`
      : 'No head-to-head history available';

  const homeInjSummary =
    homeInjuries.players.length > 0
      ? homeInjuries.players.map((p) => `${p.name} (${p.status}${p.reason ? ': ' + p.reason : ''})`).join(', ')
      : 'None reported';

  const awayInjSummary =
    awayInjuries.players.length > 0
      ? awayInjuries.players.map((p) => `${p.name} (${p.status}${p.reason ? ': ' + p.reason : ''})`).join(', ')
      : 'None reported';

  const homeRecord = `Home: ${homeTeamStats.homeRecord.wins}W-${homeTeamStats.homeRecord.losses}L${homeTeamStats.homeRecord.draws !== undefined ? `-${homeTeamStats.homeRecord.draws}D` : ''} | Away: ${homeTeamStats.awayRecord.wins}W-${homeTeamStats.awayRecord.losses}L${homeTeamStats.awayRecord.draws !== undefined ? `-${homeTeamStats.awayRecord.draws}D` : ''}`;
  const awayRecord = `Home: ${awayTeamStats.homeRecord.wins}W-${awayTeamStats.homeRecord.losses}L${awayTeamStats.homeRecord.draws !== undefined ? `-${awayTeamStats.homeRecord.draws}D` : ''} | Away: ${awayTeamStats.awayRecord.wins}W-${awayTeamStats.awayRecord.losses}L${awayTeamStats.awayRecord.draws !== undefined ? `-${awayTeamStats.awayRecord.draws}D` : ''}`;

  const schedSummary = [
    scheduleContext.homeBackToBack ? `${fixture.homeTeam} playing back-to-back` : null,
    scheduleContext.awayBackToBack ? `${fixture.awayTeam} playing back-to-back` : null,
    scheduleContext.homeLastGameDaysAgo !== undefined
      ? `${fixture.homeTeam} last played ${scheduleContext.homeLastGameDaysAgo} day(s) ago`
      : null,
    scheduleContext.awayLastGameDaysAgo !== undefined
      ? `${fixture.awayTeam} last played ${scheduleContext.awayLastGameDaysAgo} day(s) ago`
      : null,
  ]
    .filter(Boolean)
    .join('. ') || 'No schedule fatigue flags';

  const dataNote =
    matchData.dataQualityNotes.length > 0
      ? `DATA QUALITY WARNINGS: ${matchData.dataQualityNotes.join('; ')}`
      : 'Data quality appears sufficient';

  // Format available odds
  const isSoccer = fixture.competition === 'football';
  const totalsLine = matchData.availableOdds?.totalsLine ?? (isSoccer ? 2.5 : null);
  const totalsLabel = totalsLine !== null
    ? `Over/Under ${totalsLine} ${isSoccer ? 'goals' : 'points'}`
    : `Over/Under ${isSoccer ? '2.5 goals' : 'total points'}`;

  const oddsSection = matchData.availableOdds
    ? `
═══ AVAILABLE BETTING MARKETS & ODDS (Real-time from ${matchData.availableOdds.bookmakerCount} bookmakers) ═══
SPORT: ${isSoccer ? 'Football/Soccer — markets: 1X2 (Home/Draw/Away), Over/Under, BTTS' : 'Basketball — markets: Moneyline (Home/Away ONLY, no draw), Over/Under total points. BTTS and Asian Handicap DO NOT EXIST for basketball.'}

MATCH WINNER${isSoccer ? ' (1X2)' : ' (MONEYLINE — no draw)'}:
  ${fixture.homeTeam} Win: ${matchData.availableOdds.homeWin?.toFixed(2) ?? 'N/A'}${matchData.availableOdds.homeWin && matchData.availableOdds.homeWin < 1.50 ? ' ⚠️ TOO LOW — avoid this market' : ''}
${isSoccer ? `  Draw: ${matchData.availableOdds.draw?.toFixed(2) ?? 'N/A'}\n` : ''}  ${fixture.awayTeam} Win: ${matchData.availableOdds.awayWin?.toFixed(2) ?? 'N/A'}${matchData.availableOdds.awayWin && matchData.availableOdds.awayWin < 1.50 ? ' ⚠️ TOO LOW — avoid this market' : ''}

TOTALS (${totalsLabel}):
  Over: ${matchData.availableOdds.over25?.toFixed(2) ?? 'N/A'}
  Under: ${matchData.availableOdds.under25?.toFixed(2) ?? 'N/A'}
${matchData.availableOdds.bttsYes ? `
BOTH TEAMS TO SCORE:
  Yes: ${matchData.availableOdds.bttsYes.toFixed(2)}
  No: ${matchData.availableOdds.bttsNo?.toFixed(2) ?? 'N/A'}
` : ''}
⚠️ IMPORTANT: Choose the market with the best value. If Match Winner odds are below 1.50, prefer alternative markets like Over/Under${isSoccer ? ', BTTS, or Asian Handicap' : ' total points'}.
Minimum acceptable odds: 1.50 (anything lower will be automatically rejected).
`
    : `
═══ BETTING MARKETS ═══
No real-time odds available — rely on expected market dynamics based on form and standings.
⚠️ Ensure your recommended market would typically offer odds of 1.50 or higher.
${!isSoccer ? '⚠️ BASKETBALL: Do NOT recommend Draw, BTTS, or Asian Handicap — these markets do not exist.' : ''}
`;

  return `Perform a full professional betting analysis for the following match.

═══ FIXTURE ═══
Competition: ${fixture.competition} — ${fixture.league}
Match: ${fixture.homeTeam} (HOME) vs ${fixture.awayTeam} (AWAY)
Date: ${fixture.date}
${oddsSection}

═══ ${fixture.homeTeam.toUpperCase()} — FORM (last 5) ═══
${homeFormSummary}
Season record — ${homeRecord}
${homeTeamStats.averagePointsFor !== undefined ? `Avg scored: ${homeTeamStats.averagePointsFor} | Avg conceded: ${homeTeamStats.averagePointsAgainst}` : ''}
${homeTeamStats.standingPosition !== undefined ? `League position: ${homeTeamStats.standingPosition}` : ''}

═══ ${fixture.awayTeam.toUpperCase()} — FORM (last 5) ═══
${awayFormSummary}
Season record — ${awayRecord}
${awayTeamStats.averagePointsFor !== undefined ? `Avg scored: ${awayTeamStats.averagePointsFor} | Avg conceded: ${awayTeamStats.averagePointsAgainst}` : ''}
${awayTeamStats.standingPosition !== undefined ? `League position: ${awayTeamStats.standingPosition}` : ''}

═══ HEAD TO HEAD ═══
${h2hSummary}

═══ INJURY & AVAILABILITY ═══
${fixture.homeTeam}: ${homeInjSummary}
${fixture.awayTeam}: ${awayInjSummary}

═══ SCHEDULE CONTEXT ═══
${schedSummary}

═══ DATA NOTE ═══
${dataNote}
${matchData.structuredContext ? `
═══ STRUCTURED DATA (TheSportsDB — verified) ═══
${matchData.structuredContext}
` : ''}
═══ LIVE WEB SEARCH DATA ═══
${liveWebContext || 'No live data retrieved — rely on structured data and training knowledge.'}

Based on the structured data and live web search data above, produce your expert betting analysis and return it in the required JSON format.
IMPORTANT: Prioritise the STRUCTURED DATA (TheSportsDB) for standings and form over any conflicting information in the web search results — it is fetched directly from the official API.
Use the LIVE WEB SEARCH DATA not only for scores and injuries but also for team-internal context, motivation, likely rotation, coaching pressure, aggregate/game-state dynamics, and any credible non-numeric factors that change the match script.
Do not give a purely statistical recap if the live search contains relevant qualitative context.
Keep shortReasoning tight: it should read like one compact betting note, not a mini article.
If the data is insufficient to make a responsible recommendation, set isPickRecommended=false.`;
}
