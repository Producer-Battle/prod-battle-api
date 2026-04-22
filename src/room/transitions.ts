// Phase transition side effects.
// lobby→submit:  seed battle_phases, open submission upload URLs
// submit→reveal: freeze submissions, generate playback order
// reveal→vote:   open vote window (double-blind — submitter identity hidden)
// vote→results:  tally, write final_rank, update rankings (Glicko), reveal identities

export async function onEnterPhase(_matchId: string, _phase: string): Promise<void> {
  throw new Error('not implemented');
}
