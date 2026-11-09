# Lever 1: forced-uber vs specialized pixel residual (2026-11-09, gate (1) amended: FAILED in forced uber, thresholds unchanged)

- Ruled out: the 9 refused uber pixel shaders (fixed by #477/0222); the dst-alpha two-pass (0 px with it off); the position/normal form (#482/#483 give byte-identical PNGs, 24/24 and 12/12); derivatives in non-uniform control flow.
- Established: filtering amplifies the gap: nearest (min, mag and mip filter) + aniso=1 removes 85-90 % of the differing pixels (race 2.1-3.6k -> 121-427 px, split ~4.9k -> 624-642 px; intro 0 px throughout). What remains under nearest is a different texel chosen (large |d| on horizon lines and kart edges).
- Still open: are the UVs already different at the pixel shader's input (indexed texmtx, varyings from the uber VS) or does the uber PS address them differently? Branch (B), isolating one kart's draws, is paused by the judge.
- Data (local, not in the repo): the job directory j1a/uber/ (main-specialized, gate1-0222b, gate1-diag-filter/, gate1-diag-align/, compare.mjs, amended.py, GATE1-AMENDMENT.md + .sha256).
