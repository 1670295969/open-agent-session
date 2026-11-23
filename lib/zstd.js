// 多帧 zstd 解压
//
// 为什么需要这个：dsh（DeepSeek Harness）把会话写成 session.v4.jsonl.zstd，
// 而且**每追加一批事件就再压一个新帧、直接拼在文件尾部**。一个 143KB 的会话
// 文件里有 6 个连续帧，解压后 718KB。
//
// Node 内置的 zlib.zstdDecompressSync / createZstdDecompress 只解压**第一帧**
// 就停（实测只拿到 169 字节，而 zstd CLI 给出 718KB），也不认 skippable frame。
// 所以要自己按 RFC 8878 解析帧边界，逐帧解压再拼接。
//
// 帧结构（全小端）：
//   Magic(4) = 28 B5 2F FD
//   Frame_Header_Descriptor(1)
//     bit7-6  Frame_Content_Size_flag
//     bit5    Single_Segment_flag
//     bit2    Content_Checksum_flag
//     bit1-0  Dictionary_ID_flag
//   Window_Descriptor(0 或 1)   仅当 !Single_Segment
//   Dictionary_ID(0/1/2/4)      按 Dictionary_ID_flag
//   Frame_Content_Size(0/1/2/4/8)
//   然后若干 Block，每块 3 字节头（LE）：
//     bit0    Last_Block
//     bit1-2  Block_Type (0=Raw 1=RLE 2=Compressed 3=Reserved)
//     bit3-23 Block_Size
//   Content_Checksum(0 或 4)
//
// 注意 RLE 块的 Block_Size 是**解压后**长度，实际只占 1 字节 —— 前进量要减去
// size-1，否则边界会跑飞。这是最容易写错的一处。
const zlib = require("zlib");

const ZSTD_MAGIC = 0xfd2fb528;   // 28 B5 2F FD（小端读出来是这个数）
const SKIP_MAGIC_LO = 0x184d2a50; // skippable frame 的 magic 范围 0x184D2A50..5F

function readU32(b, p) {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

// 返回 [off, off+len) 这一帧的总字节数；不合法的 magic 或越界返回 -1
function frameLength(buf, off) {
  const avail = buf.length - off;
  if (avail < 8) return -1;
  const magic = readU32(buf, off);

  // skippable frame: magic(4) + size(4) + data(size)
  if ((magic & 0xfffffff0) >>> 0 === SKIP_MAGIC_LO) {
    const size = readU32(buf, off + 4);
    const total = 8 + size;
    return total <= avail ? total : -1;
  }
  if (magic !== ZSTD_MAGIC) return -1;

  let p = off + 4;
  const fhd = buf[p++];
  const fcsFlag = (fhd >> 6) & 3;
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;

  if (!singleSegment) p += 1;                     // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag];                    // Dictionary_ID
  p += (singleSegment ? [1, 2, 4, 8] : [0, 2, 4, 8])[fcsFlag]; // Frame_Content_Size
  if (p > buf.length) return -1;

  for (;;) {
    if (p + 3 > buf.length) return -1;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >> 3;
    if (type === 3) return -1;                    // reserved，说明解析已经错位
    // RLE 块：Block_Size 是解压后大小，实际存 1 字节
    p += type === 1 ? 1 : size;
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (hasChecksum) p += 4;
  const total = p - off;
  return total <= avail ? total : -1;
}

// 把多帧 buffer 解成完整明文。遇到解析不了的尾巴就停在已成功的位置 ——
// 会话是追加写的，末尾半个帧（进程被杀）很常见，不该让整条会话读不出来。
function decompressAll(buf) {
  const parts = [];
  let off = 0;
  while (off < buf.length) {
    const len = frameLength(buf, off);
    if (len <= 0) break;
    const magic = readU32(buf, off);
    if (magic === ZSTD_MAGIC) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)));
      } catch {
        break; // 该帧损坏，保留前面已解出的部分
      }
    }
    off += len; // skippable 帧直接跳过
  }
  return Buffer.concat(parts);
}

// 文件 → 明文。非 .zstd 文件直接读。
function readMaybeZstd(file, fs) {
  const raw = fs.readFileSync(file);
  if (!String(file).endsWith(".zstd")) return raw;
  return decompressAll(raw);
}

module.exports = { decompressAll, frameLength, readMaybeZstd };
