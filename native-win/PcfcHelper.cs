// PC Full Control — фоновый помощник (Windows). Заменяет два процесса PowerShell (~55 МБ) одним
// маленьким (~5–10 МБ):
//   A|имя|простой_сек|путь|во_весь_экран|описание  — раз в 15 секунд: программа на переднем плане
//   U|{json}                                       — подключение/отключение устройства
// Команды на входе (по строке): "trim <pid> <pid>…" — вернуть Windows неиспользуемую память процессов.
// Закрытие входа (программа завершилась) — помощник выходит сам.
// USB: ждём событие Windows «изменились устройства» (без постоянного опроса WMI) и сравниваем списки.
// Собирается штатным компилятором .NET Framework (C# 5): csc /r:System.Management.dll
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PcfcHelper {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", EntryPoint = "K32EmptyWorkingSet")] static extern bool EmptyWorkingSet(IntPtr h);

  static readonly object outLock = new object();
  static void Emit(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

  // ---------- программа на переднем плане ----------
  static readonly Dictionary<string, string> desc = new Dictionary<string, string>();
  static string PathOf(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try { StringBuilder sb = new StringBuilder(1024); uint n = 1024; return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; } finally { CloseHandle(h); }
  }
  static string DescOf(string path) {
    if (String.IsNullOrEmpty(path)) return "";
    string d;
    if (desc.TryGetValue(path, out d)) return d;
    try { FileVersionInfo v = FileVersionInfo.GetVersionInfo(path); d = !String.IsNullOrEmpty(v.ProductName) && v.ProductName.Length < 60 ? v.ProductName : (v.FileDescription ?? ""); } catch { d = ""; }
    if (desc.Count > 500) desc.Clear();
    desc[path] = d;
    return d;
  }
  static string Sample() {
    string name = "", path = "", d = "";
    int full = 0;
    try {
      IntPtr w = GetForegroundWindow();
      uint pid; GetWindowThreadProcessId(w, out pid);
      if (pid != 0) {
        path = PathOf(pid);
        name = System.IO.Path.GetFileNameWithoutExtension(path);
        if (String.IsNullOrEmpty(name)) { using (Process p = Process.GetProcessById((int)pid)) name = p.ProcessName; }
        d = DescOf(path);
        RECT r; MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
        if (GetWindowRect(w, out r) && GetMonitorInfo(MonitorFromWindow(w, 2), ref mi))
          full = (r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B) ? 1 : 0;
      }
    } catch { }
    LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(li);
    GetLastInputInfo(ref li);
    uint idle = ((uint)Environment.TickCount - li.dwTime) / 1000;
    return "A|" + name + "|" + idle + "|" + path + "|" + full + "|" + d.Replace("|", " ");
  }
  static void ActivityLoop() {
    for (; ; ) {
      Emit(Sample());
      Thread.Sleep(15000);
    }
  }

  // ---------- устройства ----------
  class Dev { public string Name, Cls, Id, Mfr; }
  static string J(string s) {
    if (s == null) return "\"\"";
    StringBuilder sb = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }
  static string S(object o) { return o == null ? "" : o.ToString(); }
  static Dictionary<string, Dev> Snapshot() {
    Dictionary<string, Dev> all = new Dictionary<string, Dev>();
    using (ManagementObjectSearcher q = new ManagementObjectSearcher("SELECT Name, PNPClass, DeviceID, Manufacturer FROM Win32_PnPEntity")) {
      foreach (ManagementBaseObject m in q.Get()) {
        using (m) {
          string id = S(m["DeviceID"]);
          if (id.Length == 0) continue;
          all[id] = new Dev { Name = S(m["Name"]), Cls = S(m["PNPClass"]), Id = id, Mfr = S(m["Manufacturer"]) };
        }
      }
    }
    return all;
  }
  static void EmitDev(string kind, Dev d) {
    Emit("U|{\"kind\":" + J(kind) + ",\"name\":" + J(d.Name) + ",\"cls\":" + J(d.Cls) + ",\"id\":" + J(d.Id) + ",\"mfr\":" + J(d.Mfr) + "}");
  }
  static Dictionary<string, Dev> known;
  static readonly AutoResetEvent changed = new AutoResetEvent(false);
  static void UsbLoop() {
    try {
      known = Snapshot();
      // Событие без опроса: Windows сама сообщает, что набор устройств изменился
      ManagementEventWatcher w = new ManagementEventWatcher(new WqlEventQuery("SELECT * FROM Win32_DeviceChangeEvent"));
      w.EventArrived += delegate { changed.Set(); };
      w.Start();
      Emit("U|ready");
    } catch (Exception e) { Emit("U|error " + e.Message.Replace("\r", " ").Replace("\n", " ")); return; }
    for (; ; ) {
      changed.WaitOne();
      Thread.Sleep(1200); // одно подключение — пачка событий: ждём, пока Windows закончит
      while (changed.WaitOne(0)) { }
      try {
        Dictionary<string, Dev> now = Snapshot();
        foreach (KeyValuePair<string, Dev> kv in now) if (!known.ContainsKey(kv.Key)) EmitDev("add", kv.Value);
        foreach (KeyValuePair<string, Dev> kv in known) if (!now.ContainsKey(kv.Key)) EmitDev("remove", kv.Value);
        known = now;
      } catch { }
      Trim(GetCurrentProcess());
    }
  }

  // ---------- память ----------
  static void Trim(IntPtr h) { try { EmptyWorkingSet(h); } catch { } }
  static void TrimPids(string[] parts) {
    for (int i = 1; i < parts.Length; i++) {
      uint pid;
      if (!UInt32.TryParse(parts[i], out pid)) continue;
      IntPtr h = OpenProcess(0x0400 | 0x0100, false, pid); // QUERY_INFORMATION | SET_QUOTA
      if (h == IntPtr.Zero) continue;
      try { Trim(h); } finally { CloseHandle(h); }
    }
    Trim(GetCurrentProcess());
  }

  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    bool activity = Array.IndexOf(args, "activity") >= 0;
    bool usb = Array.IndexOf(args, "usb") >= 0;
    if (Array.IndexOf(args, "--version") >= 0) { Console.Out.WriteLine("pcfc-helper 1"); return 0; }
    if (Array.IndexOf(args, "--sample") >= 0) { Console.Out.WriteLine(Sample()); return 0; }
    if (activity) { Thread t = new Thread(ActivityLoop); t.IsBackground = true; t.Start(); }
    if (usb) { Thread t = new Thread(UsbLoop); t.IsBackground = true; t.Start(); }
    Emit("ready");
    Trim(GetCurrentProcess());
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] parts = line.Trim().Split(' ');
      if (parts[0] == "trim") TrimPids(parts);
      else if (parts[0] == "ping") Emit("pong");
    }
    return 0; // программа закрылась — выходим
  }
}
