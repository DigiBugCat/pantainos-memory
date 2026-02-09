/**
 * Spectral Radius Estimation (Paper Theorem 1)
 *
 * Estimates α·‖Â⁺ − η·Â⁻‖₂ via power iteration on the implicit
 * adjacency matrix M = Â⁺ − η·Â⁻. Used to verify the contraction
 * condition (spectral radius < 1) before fixed-point iteration.
 */

type AdjacencyMap = Map<string, Array<{ source_id: string; strength: number }>>;

const POWER_ITERATIONS = 20;

/**
 * Estimate spectral radius of α·(Â⁺ − η·Â⁻) via power iteration.
 *
 * The matrix-vector product for node i:
 *   (M·v)[i] = Σ(support_strength_ij · v[j]) / totalSupportStrength_i
 *            − eta · Σ(contradiction_strength_ij · v[j]) / totalContradictionStrength_i
 *
 * Non-updateable nodes contribute 0 to the product (they are fixed).
 *
 * @returns alpha * estimated spectral radius (norm of M)
 */
export function estimateSpectralRadius(
  nodeIds: string[],
  incoming: AdjacencyMap,
  contradictionIncoming: AdjacencyMap,
  alpha: number,
  eta: number,
  isUpdateable: (id: string) => boolean,
): number {
  if (nodeIds.length === 0) return 0;

  const updateableIds = nodeIds.filter(isUpdateable);
  if (updateableIds.length === 0) return 0;

  // Initialize random unit vector (seeded with deterministic values for stability)
  let v = new Map<string, number>();
  let norm = 0;
  for (let i = 0; i < updateableIds.length; i++) {
    const val = Math.sin(i + 1); // deterministic pseudo-random
    v.set(updateableIds[i], val);
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return 0;
  for (const id of updateableIds) {
    v.set(id, (v.get(id) ?? 0) / norm);
  }

  let eigenEstimate = 0;

  for (let iter = 0; iter < POWER_ITERATIONS; iter++) {
    const mv = new Map<string, number>();

    for (const id of updateableIds) {
      // Support term: strength-weighted mean of incoming support
      const inc = incoming.get(id) ?? [];
      let supportSum = 0;
      let strengthSum = 0;
      for (const s of inc) {
        const sv = v.get(s.source_id) ?? 0;
        supportSum += s.strength * sv;
        strengthSum += s.strength;
      }
      const support = strengthSum > 0 ? (supportSum / strengthSum) : 0;

      // Contradiction term: strength-weighted mean of incoming contradictions
      const cInc = contradictionIncoming.get(id) ?? [];
      let contrSum = 0;
      let contrStrengthSum = 0;
      for (const s of cInc) {
        const sv = v.get(s.source_id) ?? 0;
        contrSum += s.strength * sv;
        contrStrengthSum += s.strength;
      }
      const contradiction = contrStrengthSum > 0 ? (contrSum / contrStrengthSum) : 0;

      mv.set(id, support - eta * contradiction);
    }

    // Compute norm of M·v
    let newNorm = 0;
    for (const id of updateableIds) {
      const val = mv.get(id) ?? 0;
      newNorm += val * val;
    }
    newNorm = Math.sqrt(newNorm);

    eigenEstimate = alpha * newNorm;

    // Normalize for next iteration
    if (newNorm < 1e-12) return 0;
    v = new Map<string, number>();
    for (const id of updateableIds) {
      v.set(id, (mv.get(id) ?? 0) / newNorm);
    }
  }

  return eigenEstimate;
}
