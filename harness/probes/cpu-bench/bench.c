// Deterministic single-core micro-benchmark: a tiny register-machine
// interpreter (dispatch, integer ALU, loads/stores, branches, some float),
// the shape of an emulator's inner loop. Returns a checksum.
typedef unsigned int u32;
static u32 mem[4096];
static unsigned char prog[256];
__attribute__((export_name("run")))
u32 run(u32 iterations) {
  u32 r[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  float f = 1.0f;
  u32 seed = 12345;
  for (int i = 0; i < 256; i++) { seed = seed * 1103515245u + 12345u; prog[i] = (unsigned char)(seed >> 16); }
  for (int i = 0; i < 4096; i++) mem[i] = i * 2654435761u;
  u32 pc = 0;
  for (u32 n = 0; n < iterations; n++) {
    unsigned char op = prog[pc & 255];
    u32 a = op & 7, b = (op >> 3) & 7;
    switch (op >> 5) {
      case 0: r[a] += r[b] + 1; break;
      case 1: r[a] ^= (r[b] << 3) | (r[b] >> 29); break;
      case 2: r[a] = mem[(r[b] + n) & 4095]; break;
      case 3: mem[(r[a] ^ n) & 4095] = r[b]; break;
      case 4: if (r[a] & 1) pc += r[b] & 15; break;
      case 5: f = f * 1.0000001f + (float)(r[b] & 255) * 0.001f; r[a] += (u32)f; break;
      case 6: r[a] = r[a] * 2654435761u + r[b]; break;
      default: r[a] = (r[a] >> 1) | (r[b] << 31); break;
    }
    pc++;
  }
  u32 h = 0;
  for (int i = 0; i < 8; i++) h = h * 31 + r[i];
  return h ^ mem[r[0] & 4095];
}
