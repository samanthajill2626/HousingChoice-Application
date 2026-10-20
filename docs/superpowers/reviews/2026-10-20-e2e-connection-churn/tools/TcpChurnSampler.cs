// Passive TCP-table sampler for the e2e connection-churn diagnosis.
// Polls GetExtendedTcpTable (IPv4 + IPv6, owner PID) every intervalMs and records
// every loopback endpoint that touches a watched port. Changes nothing in the
// processes under test.
//
// Outputs (in outDir):
//   series.tsv  - one line per second: totals and per-watched-port counts
//   conns.tsv   - one line per endpoint lifetime (written when it leaves the table)
//   pids.tsv    - pid -> name + command line (resolved via WMI on first sight)
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TcpChurnSampler
{
    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int dwOutBufLen, bool sort, int ipVersion, int tblClass, uint reserved);

    const int AF_INET = 2, AF_INET6 = 23, TCP_TABLE_OWNER_PID_ALL = 5;
    const int ST_ESTABLISHED = 5, ST_TIME_WAIT = 11;

    class Rec
    {
        public int Fam, LPort, RPort, Pid, FirstState, LastState;
        public long FirstMs, LastMs, EstFirstMs = -1, EstLastMs = -1, TwFirstMs = -1;
        public int StatesMask;
        public long SeenGen;
    }

    static int Port(uint p) { return (int)(((p & 0xFF) << 8) | ((p >> 8) & 0xFF)); }

    static bool Loop4(uint addr) { return (addr & 0xFF) == 127; }

    static bool Loop6(byte[] b, int o)
    {
        bool zeros10 = true;
        for (int i = 0; i < 10; i++) if (b[o + i] != 0) { zeros10 = false; break; }
        if (!zeros10) return false;
        // ::1
        bool isOne = b[o + 10] == 0 && b[o + 11] == 0 && b[o + 12] == 0 && b[o + 13] == 0 && b[o + 14] == 0 && b[o + 15] == 1;
        if (isOne) return true;
        // ::ffff:127.x.x.x
        return b[o + 10] == 0xFF && b[o + 11] == 0xFF && b[o + 12] == 127;
    }

    static byte[] Fetch(int fam, ref int size)
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                int s = size;
                uint ret = GetExtendedTcpTable(buf, ref s, false, fam, TCP_TABLE_OWNER_PID_ALL, 0);
                if (ret == 0)
                {
                    byte[] data = new byte[s];
                    Marshal.Copy(buf, data, 0, s);
                    return data;
                }
                if (ret == 122) { size = s + 65536; continue; } // ERROR_INSUFFICIENT_BUFFER
                return null;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        return null;
    }

    public static void Run(string outDir, int[] watch, int intervalMs, int maxSeconds, string stopFile)
    {
        Directory.CreateDirectory(outDir);
        var watchSet = new HashSet<int>(watch);
        var recs = new Dictionary<string, Rec>();
        var pidSeen = new HashSet<int>();
        var pidQueue = new BlockingCollection<int>();
        var sw = Stopwatch.StartNew();
        long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

        var series = new StreamWriter(Path.Combine(outDir, "series.tsv"), false, new UTF8Encoding(false));
        var conns = new StreamWriter(Path.Combine(outDir, "conns.tsv"), false, new UTF8Encoding(false));
        var pids = new StreamWriter(Path.Combine(outDir, "pids.tsv"), false, new UTF8Encoding(false));
        var hdr = new StringBuilder("tMs\tepochMs\tallTotal\tallTW\tallEst\tloopTW");
        foreach (int p in watch) hdr.Append("\tsrvTW_" + p + "\tcliTW_" + p + "\tcliEst_" + p + "\tsrvEst_" + p);
        series.WriteLine(hdr.ToString());
        conns.WriteLine("fam\tlport\trport\tpid\tfirstMs\tlastMs\tfirstState\tlastState\tstatesMask\testFirstMs\testLastMs\ttwFirstMs");
        pids.WriteLine("pid\tname\tparent\tcmdline");
        series.WriteLine("#epochStartMs=" + epochMs + " intervalMs=" + intervalMs);

        var pidThread = new Thread(() =>
        {
            foreach (int pid in pidQueue.GetConsumingEnumerable())
            {
                string name = "?", cmd = "?", parent = "?";
                try
                {
                    using (var s = new ManagementObjectSearcher("SELECT Name,ParentProcessId,CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                    foreach (ManagementObject mo in s.Get())
                    {
                        name = Convert.ToString(mo["Name"]);
                        parent = Convert.ToString(mo["ParentProcessId"]);
                        cmd = Convert.ToString(mo["CommandLine"]) ?? "";
                    }
                }
                catch (Exception e) { cmd = "ERR " + e.Message; }
                lock (pids) { pids.WriteLine(pid + "\t" + name + "\t" + parent + "\t" + (cmd ?? "").Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ')); pids.Flush(); }
            }
        });
        pidThread.IsBackground = true;
        pidThread.Start();

        int size4 = 1 << 20, size6 = 1 << 20;
        long gen = 0, lastSeriesMs = -1000, samples = 0, maxLoopMs = 0;
        int[] srvTW = new int[65536], cliTW = new int[65536], cliEst = new int[65536], srvEst = new int[65536];

        while (true)
        {
            long t0 = sw.ElapsedMilliseconds;
            if (maxSeconds > 0 && t0 > maxSeconds * 1000L) break;
            if (stopFile != null && stopFile.Length > 0 && File.Exists(stopFile)) break;
            gen++;
            samples++;
            int allTotal = 0, allTW = 0, allEst = 0, loopTW = 0;
            foreach (int p in watch) { srvTW[p] = 0; cliTW[p] = 0; cliEst[p] = 0; srvEst[p] = 0; }

            for (int f = 0; f < 2; f++)
            {
                int fam = f == 0 ? AF_INET : AF_INET6;
                byte[] d = f == 0 ? Fetch(fam, ref size4) : Fetch(fam, ref size6);
                if (d == null) continue;
                int n = BitConverter.ToInt32(d, 0);
                int rowSize = f == 0 ? 24 : 56;
                for (int i = 0; i < n; i++)
                {
                    int o = 4 + i * rowSize;
                    int state, lport, rport, pid;
                    bool loop;
                    if (f == 0)
                    {
                        state = BitConverter.ToInt32(d, o);
                        uint la = BitConverter.ToUInt32(d, o + 4);
                        lport = Port(BitConverter.ToUInt32(d, o + 8));
                        uint ra = BitConverter.ToUInt32(d, o + 12);
                        rport = Port(BitConverter.ToUInt32(d, o + 16));
                        pid = BitConverter.ToInt32(d, o + 20);
                        loop = Loop4(la) && Loop4(ra);
                    }
                    else
                    {
                        lport = Port(BitConverter.ToUInt32(d, o + 20));
                        rport = Port(BitConverter.ToUInt32(d, o + 44));
                        state = BitConverter.ToInt32(d, o + 48);
                        pid = BitConverter.ToInt32(d, o + 52);
                        loop = Loop6(d, o) && Loop6(d, o + 24);
                    }
                    allTotal++;
                    if (state == ST_TIME_WAIT) { allTW++; if (loop) loopTW++; }
                    if (state == ST_ESTABLISHED) allEst++;
                    if (!loop || state == 2) continue; // skip LISTEN
                    bool lw = watchSet.Contains(lport), rw = watchSet.Contains(rport);
                    if (!lw && !rw) continue;
                    if (state == ST_TIME_WAIT) { if (lw) srvTW[lport]++; if (rw) cliTW[rport]++; }
                    if (state == ST_ESTABLISHED) { if (rw) cliEst[rport]++; if (lw) srvEst[lport]++; }

                    string key = f + "|" + lport + ">" + rport;
                    Rec r;
                    long now = sw.ElapsedMilliseconds;
                    if (recs.TryGetValue(key, out r))
                    {
                        // A TIME_WAIT tuple that comes back ESTABLISHED is a NEW connection (reuse).
                        if (r.LastState == ST_TIME_WAIT && state != ST_TIME_WAIT)
                        {
                            Emit(conns, r);
                            recs.Remove(key);
                            r = null;
                        }
                    }
                    if (r == null)
                    {
                        r = new Rec { Fam = f == 0 ? 4 : 6, LPort = lport, RPort = rport, FirstMs = now, FirstState = state };
                        recs[key] = r;
                    }
                    r.LastMs = now;
                    r.LastState = state;
                    r.StatesMask |= 1 << state;
                    r.SeenGen = gen;
                    if (pid != 0 && r.Pid == 0) r.Pid = pid;
                    if (state == ST_ESTABLISHED) { if (r.EstFirstMs < 0) r.EstFirstMs = now; r.EstLastMs = now; }
                    if (state == ST_TIME_WAIT && r.TwFirstMs < 0) r.TwFirstMs = now;
                    if (pid != 0 && pidSeen.Add(pid)) pidQueue.Add(pid);
                }
            }

            // Retire endpoints that left the table.
            if (gen % 5 == 0)
            {
                var gone = new List<string>();
                foreach (var kv in recs) if (kv.Value.SeenGen < gen) gone.Add(kv.Key);
                foreach (var k in gone) { Emit(conns, recs[k]); recs.Remove(k); }
            }

            long t1 = sw.ElapsedMilliseconds;
            if (t1 - t0 > maxLoopMs) maxLoopMs = t1 - t0;
            if (t1 - lastSeriesMs >= 1000)
            {
                lastSeriesMs = t1;
                var sb = new StringBuilder();
                sb.Append(t1).Append('\t').Append(epochMs + t1).Append('\t').Append(allTotal).Append('\t').Append(allTW).Append('\t').Append(allEst).Append('\t').Append(loopTW);
                foreach (int p in watch) sb.Append('\t').Append(srvTW[p]).Append('\t').Append(cliTW[p]).Append('\t').Append(cliEst[p]).Append('\t').Append(srvEst[p]);
                series.WriteLine(sb.ToString());
                series.Flush();
                conns.Flush();
            }
            int sleep = intervalMs - (int)(sw.ElapsedMilliseconds - t0);
            if (sleep > 0) Thread.Sleep(sleep);
        }
        foreach (var kv in recs) Emit(conns, kv.Value);
        series.WriteLine("#end samples=" + samples + " maxLoopMs=" + maxLoopMs + " elapsedMs=" + sw.ElapsedMilliseconds);
        series.Flush(); series.Close();
        conns.Flush(); conns.Close();
        pidQueue.CompleteAdding();
        pidThread.Join(10000);
        lock (pids) { pids.Flush(); pids.Close(); }
    }

    static void Emit(StreamWriter w, Rec r)
    {
        w.WriteLine(r.Fam + "\t" + r.LPort + "\t" + r.RPort + "\t" + r.Pid + "\t" + r.FirstMs + "\t" + r.LastMs + "\t" + r.FirstState + "\t" + r.LastState + "\t" + r.StatesMask + "\t" + r.EstFirstMs + "\t" + r.EstLastMs + "\t" + r.TwFirstMs);
    }
}
