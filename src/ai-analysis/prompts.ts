import type { MatchData } from '../types';

// ─── System prompts ───────────────────────────────────────────────────────────

export const EXPERT_DEVELOPER_PROMPT = `Είσαι elite επαγγελματίας αθλητικός αναλυτής στοιχήματος. Οι αναλύσεις σου απευθύνονται σε σοβαρούς παίκτες και πρέπει να είναι αυστηρές, καθαρές και υπεύθυνες.

Βασικοί κανόνες:
1. Έχει ήδη γίνει LIVE WEB SEARCH ειδικά για αυτό το fixture και το αποτέλεσμα δίνεται πιο κάτω. Βάσισε την ανάλυση κυρίως εκεί, αλλά όταν υπάρχουν verified structured/API δεδομένα δώσε τους προτεραιότητα.
2. Ξεχώριζε καθαρά τα ΕΠΙΒΕΒΑΙΩΜΕΝΑ facts από την ΕΚΤΙΜΗΣΗ.
3. Αν τα δεδομένα είναι φτωχά, αντιφατικά ή αναξιόπιστα, βάλε isPickRecommended=false και εξήγησε γιατί.
4. Δώσε ΜΙΑ καλύτερη επιλογή, όχι λίστα επιλογών.
5. Απόφυγε picks χωρίς καθαρό edge.
6. Μην κάνεις την ανάλυση απλή αριθμητική φόρμας και αποδόσεων. Αν υπάρχει ουσιαστικό team context, rotation, coaching pressure, morale, δηλώσεις, ταξίδι, motivation ή match-state, βάλ' το καθαρά σε keyFacts, riskFactors και shortReasoning.
7. Έξυπνη επιλογή αγοράς: θα δεις πραγματικές αποδόσεις για πολλαπλές αγορές. Διάλεξε την αγορά με το καλύτερο risk/reward.
  - Αν το σημείο νίκης είναι κάτω από 1.50, μην το προτιμάς αυτόματα.
  - Στο ποδόσφαιρο σκέψου και totals ή BTTS όταν έχει περισσότερο value.
  - Στο μπάσκετ allowed markets είναι μόνο h2h/home, h2h/away, totals/over, totals/under.
  - Στο μπάσκετ δεν υπάρχει ισοπαλία.
  - Αν όλα τα διαθέσιμα markets είναι κάτω από 1.50, γύρνα no-pick.
8. Να είσαι ειλικρινής στα risk factors.
9. Confidence σωστά βαθμονομημένο: 7+ ισχυρή άποψη, 5-6 μέτρια, κάτω από 5 κανονικά no-pick.
10. Το output πρέπει να ακολουθεί ακριβώς το JSON schema.
11. Προτίμησε λίγα αλλά υψηλού σήματος facts. Κάθε fact ή risk πρέπει να εξηγεί τι σημαίνει για tempo, script, mentality ή market value.

Γλώσσα output:
- Όλα τα text fields στα ελληνικά.
- Team names, player names και coach names με ελληνικούς χαρακτήρες, όχι λατινικά.
- Μην αλλάζεις betting labels όπως Over, Under, G/G, NG.
- finalPick με σύντομα betting labels: "Άσσος", "Ισοπαλία", "Διπλό", "G/G", "NG", "Over 2.5", "Under 2.5", "Over 215.5", "Under 215.5".
- bestBettingMarket μόνο με τα machine-readable enum values του schema.

Τόνος shortReasoning:
- φυσικός, καθαρός, ανθρώπινος, σαν δυνατό analyst post σε Telegram group
- 2-4 σύντομες προτάσεις
- όχι ρομποτικός ή υπερβολικά επίσημος
- όχι AI-speak τύπου "το μοντέλο δείχνει"
- βάλε τουλάχιστον ένα qualitative angle όταν υπάρχει, αλλά κράτα το compact`;

export function buildExpertUserPrompt(matchData: MatchData, liveWebContext: string = ''): string {
  const { fixture, homeTeamStats, awayTeamStats, h2h, homeInjuries, awayInjuries, scheduleContext, cachedKnowledgeContext } = matchData;

  const homeFormSummary = homeTeamStats.lastFiveGames
    .map((g) => `${g.result} vs ${g.opponent} (${g.score}, ${g.isHome ? 'Ε' : 'ΕΚ'})`)
    .join(' | ') || 'Δεν υπάρχουν διαθέσιμα δεδομένα φόρμας';

  const awayFormSummary = awayTeamStats.lastFiveGames
    .map((g) => `${g.result} vs ${g.opponent} (${g.score}, ${g.isHome ? 'Ε' : 'ΕΚ'})`)
    .join(' | ') || 'Δεν υπάρχουν διαθέσιμα δεδομένα φόρμας';

  const h2hSummary =
    h2h.totalGames > 0
      ? `${h2h.totalGames} ματς: ${fixture.homeTeam} ${h2h.homeTeamWins}Ν – ${fixture.awayTeam} ${h2h.awayTeamWins}Ν – ${h2h.draws}Ι. Τελευταία 5: ${h2h.lastFiveGames.map((g) => `${g.homeTeam} ${g.homeScore}-${g.awayScore} ${g.awayTeam}`).join(' | ')}`
      : 'Δεν υπάρχει διαθέσιμο head-to-head ιστορικό';

  const homeInjSummary =
    homeInjuries.players.length > 0
      ? homeInjuries.players.map((p) => `${p.name} (${p.status}${p.reason ? ': ' + p.reason : ''})`).join(', ')
      : 'Καμία αναφορά';

  const awayInjSummary =
    awayInjuries.players.length > 0
      ? awayInjuries.players.map((p) => `${p.name} (${p.status}${p.reason ? ': ' + p.reason : ''})`).join(', ')
      : 'Καμία αναφορά';

  const homeRecord = `Εντός: ${homeTeamStats.homeRecord.wins}Ν-${homeTeamStats.homeRecord.losses}Η${homeTeamStats.homeRecord.draws !== undefined ? `-${homeTeamStats.homeRecord.draws}Ι` : ''} | Εκτός: ${homeTeamStats.awayRecord.wins}Ν-${homeTeamStats.awayRecord.losses}Η${homeTeamStats.awayRecord.draws !== undefined ? `-${homeTeamStats.awayRecord.draws}Ι` : ''}`;
  const awayRecord = `Εντός: ${awayTeamStats.homeRecord.wins}Ν-${awayTeamStats.homeRecord.losses}Η${awayTeamStats.homeRecord.draws !== undefined ? `-${awayTeamStats.homeRecord.draws}Ι` : ''} | Εκτός: ${awayTeamStats.awayRecord.wins}Ν-${awayTeamStats.awayRecord.losses}Η${awayTeamStats.awayRecord.draws !== undefined ? `-${awayTeamStats.awayRecord.draws}Ι` : ''}`;

  const schedSummary = [
    scheduleContext.homeBackToBack ? `${fixture.homeTeam} παίζει back-to-back` : null,
    scheduleContext.awayBackToBack ? `${fixture.awayTeam} παίζει back-to-back` : null,
    scheduleContext.homeLastGameDaysAgo !== undefined
      ? `${fixture.homeTeam} έπαιξε τελευταία φορά πριν από ${scheduleContext.homeLastGameDaysAgo} ημέρα/ες`
      : null,
    scheduleContext.awayLastGameDaysAgo !== undefined
      ? `${fixture.awayTeam} έπαιξε τελευταία φορά πριν από ${scheduleContext.awayLastGameDaysAgo} ημέρα/ες`
      : null,
  ]
    .filter(Boolean)
    .join('. ') || 'Δεν υπάρχουν ενδείξεις κόπωσης από το πρόγραμμα';

  const dataNote =
    matchData.dataQualityNotes.length > 0
      ? `ΠΡΟΕΙΔΟΠΟΙΗΣΕΙΣ ΠΟΙΟΤΗΤΑΣ: ${matchData.dataQualityNotes.join('; ')}`
      : 'Η ποιότητα δεδομένων φαίνεται επαρκής';

  // Format available odds
  const isSoccer = fixture.competition === 'football';
  const totalsLine = matchData.availableOdds?.totalsLine ?? (isSoccer ? 2.5 : null);
  const totalsLabel = totalsLine !== null
    ? `Over/Under ${totalsLine} ${isSoccer ? 'γκολ' : 'πόντοι'}`
    : `Over/Under ${isSoccer ? '2.5 γκολ' : 'συνολικοί πόντοι'}`;

  const oddsSection = matchData.availableOdds
    ? `
═══ ΔΙΑΘΕΣΙΜΕΣ ΑΓΟΡΕΣ & ΑΠΟΔΟΣΕΙΣ (live από ${matchData.availableOdds.bookmakerCount} bookmakers) ═══
SPORT: ${isSoccer ? 'Ποδόσφαιρο — αγορές 1X2, Over/Under, BTTS' : 'Μπάσκετ — αγορές Moneyline και Over/Under συνολικών πόντων. Δεν υπάρχουν BTTS, Asian Handicap ή ισοπαλία.'}

ΝΙΚΗ ΑΓΩΝΑ${isSoccer ? ' (1X2)' : ' (MONEYLINE)'}:
  ${fixture.homeTeam}: ${matchData.availableOdds.homeWin?.toFixed(2) ?? 'N/A'}${matchData.availableOdds.homeWin && matchData.availableOdds.homeWin < 1.50 ? ' ⚠️ πολύ χαμηλό' : ''}
${isSoccer ? `  Ισοπαλία: ${matchData.availableOdds.draw?.toFixed(2) ?? 'N/A'}\n` : ''}  ${fixture.awayTeam}: ${matchData.availableOdds.awayWin?.toFixed(2) ?? 'N/A'}${matchData.availableOdds.awayWin && matchData.availableOdds.awayWin < 1.50 ? ' ⚠️ πολύ χαμηλό' : ''}

TOTALS (${totalsLabel}):
  Over: ${matchData.availableOdds.over25?.toFixed(2) ?? 'N/A'}
  Under: ${matchData.availableOdds.under25?.toFixed(2) ?? 'N/A'}
${matchData.availableOdds.bttsYes ? `
G/G:
  Yes: ${matchData.availableOdds.bttsYes.toFixed(2)}
  No: ${matchData.availableOdds.bttsNo?.toFixed(2) ?? 'N/A'}
` : ''}
ΣΗΜΑΝΤΙΚΟ: Διάλεξε την αγορά με το καλύτερο value. Αν το σημείο νίκης είναι κάτω από 1.50, προτίμησε εναλλακτικές αγορές όπως totals${isSoccer ? ' ή BTTS' : ''}.
Ελάχιστη αποδεκτή απόδοση: 1.50.
`
    : `
═══ ΑΓΟΡΕΣ ΣΤΟΙΧΗΜΑΤΟΣ ═══
Δεν υπάρχουν διαθέσιμες live αποδόσεις — στηρίξου σε expected market dynamics από φόρμα, context και standings.
Βεβαιώσου ότι η προτεινόμενη αγορά κανονικά θα έδινε απόδοση 1.50 ή μεγαλύτερη.
${!isSoccer ? 'Στο μπάσκετ μην προτείνεις Draw, BTTS ή Asian Handicap.' : ''}
`;

  return `Κάνε πλήρη επαγγελματική στοιχηματική ανάλυση για το παρακάτω ματς.

═══ FIXTURE ═══
Διοργάνωση: ${fixture.competition} — ${fixture.league}
Αγώνας: ${fixture.homeTeam} (ΓΗΠΕΔΟΥΧΟΣ) vs ${fixture.awayTeam} (ΦΙΛΟΞΕΝΟΥΜΕΝΟΣ)
Ημερομηνία: ${fixture.date}
${oddsSection}

═══ ${fixture.homeTeam.toUpperCase()} — ΦΟΡΜΑ (τελευταία 5) ═══
${homeFormSummary}
Συνολικό split — ${homeRecord}
${homeTeamStats.averagePointsFor !== undefined ? `Μ.Ο. υπέρ: ${homeTeamStats.averagePointsFor} | Μ.Ο. κατά: ${homeTeamStats.averagePointsAgainst}` : ''}
${homeTeamStats.standingPosition !== undefined ? `Θέση στη βαθμολογία: ${homeTeamStats.standingPosition}` : ''}

═══ ${fixture.awayTeam.toUpperCase()} — ΦΟΡΜΑ (τελευταία 5) ═══
${awayFormSummary}
Συνολικό split — ${awayRecord}
${awayTeamStats.averagePointsFor !== undefined ? `Μ.Ο. υπέρ: ${awayTeamStats.averagePointsFor} | Μ.Ο. κατά: ${awayTeamStats.averagePointsAgainst}` : ''}
${awayTeamStats.standingPosition !== undefined ? `Θέση στη βαθμολογία: ${awayTeamStats.standingPosition}` : ''}

═══ HEAD TO HEAD ═══
${h2hSummary}

═══ ΑΠΟΥΣΙΕΣ & ΔΙΑΘΕΣΙΜΟΤΗΤΑ ═══
${fixture.homeTeam}: ${homeInjSummary}
${fixture.awayTeam}: ${awayInjSummary}

═══ CONTEXT ΠΡΟΓΡΑΜΜΑΤΟΣ ═══
${schedSummary}

═══ NOTE ΠΟΙΟΤΗΤΑΣ ΔΕΔΟΜΕΝΩΝ ═══
${dataNote}
${matchData.structuredContext ? `
═══ STRUCTURED DATA (API-Sports — verified) ═══
${matchData.structuredContext}
` : ''}
${cachedKnowledgeContext ? `
${cachedKnowledgeContext}
` : ''}
═══ LIVE WEB SEARCH DATA ═══
${liveWebContext || 'Δεν ανακτήθηκε live web context — στηρίξου στα structured data και στη γνώση σου.'}

Με βάση τα structured data, το τοπικό cache και το live web search data παραπάνω, δώσε την expert betting analysis στο απαιτούμενο JSON format.
ΣΗΜΑΝΤΙΚΟ: Όταν υπάρχουν STRUCTURED DATA από API-Sports, δώσε τους προτεραιότητα γιατί είναι direct provider data.
Χρησιμοποίησε το LIVE WEB SEARCH DATA κυρίως για φρέσκα ή ελλείποντα στοιχεία: injuries, motivation, rotation, coaching pressure, aggregate/game-state dynamics και γενικά ό,τι αλλάζει ουσιαστικά το script.
Μην κάνεις απλό statistical recap αν υπάρχει ποιοτικό context.
Κράτα το shortReasoning compact σαν καθαρό betting note, όχι σαν mini article.
Αν τα δεδομένα δεν αρκούν για υπεύθυνη πρόταση, βάλε isPickRecommended=false.`;
}
