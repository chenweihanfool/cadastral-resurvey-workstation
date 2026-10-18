"""DBF 探索工具：python -I dbfdump.py 檔案 [筆數]；輸出 UTF-8 到 stdout 檔"""
import struct, sys
def read_dbf(path):
    d = open(path, "rb").read()
    n, hl, rl = struct.unpack("<IHH", d[4:12])
    fields, o = [], 32
    while d[o] != 0x0D:
        fields.append((d[o:o+11].split(b"\0")[0].decode(), chr(d[o+11]), d[o+16], d[o+17])); o += 32
    recs = []
    for i in range(n):
        r = d[hl+i*rl: hl+(i+1)*rl]
        deleted = r[0:1] == b"*"
        p, row = 1, {}
        for nm, t, ln, dc in fields:
            raw = r[p:p+ln]; p += ln
            s = raw.decode("big5", errors="replace").strip()
            if t == "N":
                try: row[nm] = float(s) if dc else int(s)
                except ValueError: row[nm] = None
            elif t == "L": row[nm] = s in ("T", "t", "Y", "y")
            else: row[nm] = s
        row["_del"] = deleted
        recs.append(row)
    return fields, recs
if __name__ == "__main__":
    f, recs = read_dbf(sys.argv[1]); k = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    print(sys.argv[1], len(recs), "recs"); print(f)
    for r in recs[:k]: print(r)
