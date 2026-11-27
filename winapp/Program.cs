using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Harmonia")]
[assembly: AssemblyProduct("Harmonia")]
[assembly: AssemblyCompany("Harmonia")]
[assembly: AssemblyDescription("Harmonia desktop app")]
[assembly: AssemblyCopyright("Harmonia")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const int Port = 4747;
    const int RelaunchExit = 75; // the server installed an update (updates.ts): open the new build
    static readonly string BaseDir = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Harmonia");
    static string StateFile { get { return Path.Combine(Data, "window.txt"); } }
    static string LogFile { get { return Path.Combine(Data, "server.log"); } }

    static void Log(string m)
    {
        try { Directory.CreateDirectory(Data); File.AppendAllText(Path.Combine(Data, "app.log"), DateTime.Now.ToString("s") + " " + m + "\r\n"); } catch { }
    }

    static bool Up()
    {
        try { using (var c = new TcpClient()) { c.Connect("127.0.0.1", Port); return true; } } catch { return false; }
    }

    // A job object, so the server can never outlive the app (even if the app is killed).
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint Flags, c; public UIntPtr d, e; public uint f; public UIntPtr g; public uint h, i; }
    [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p, j, pk, pkm; }
    static void KillWithMe(Process p)
    {
        try
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            var info = new EXT(); info.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
            int len = Marshal.SizeOf(typeof(EXT)); IntPtr mem = Marshal.AllocHGlobal(len);
            Marshal.StructureToPtr(info, mem, false);
            SetInformationJobObject(job, 9, mem, (uint)len);
            AssignProcessToJobObject(job, p.Handle);
        }
        catch { }
    }

    static Process StartServer()
    {
        Directory.CreateDirectory(Data);
        var dir = AppDomain.CurrentDomain.BaseDirectory;
        var exe = Path.Combine(dir, "harmonia-server.exe");
        if (!File.Exists(exe)) throw new FileNotFoundException("harmonia-server.exe is missing from " + dir);
        var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + exe + "\" >> \"" + LogFile + "\" 2>&1\"")
        { WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true };
        var p = Process.Start(psi);
        KillWithMe(p);
        return p;
    }

    [STAThread]
    static void Main(string[] args)
    {
        // Started by the previous build after an update: let it finish quitting (it holds the single-instance lock).
        if (args.Length == 2 && args[0] == "--after")
        {
            try { using (var old = Process.GetProcessById(int.Parse(args[1]))) old.WaitForExit(20000); } catch { }
        }
        bool first;
        var mutex = new Mutex(true, "Harmonia.SingleInstance", out first);
        var wake = new EventWaitHandle(false, EventResetMode.AutoReset, "Harmonia.Wake");
        if (!first) { wake.Set(); return; }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (s, e) => Log("ThreadException: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (s, e) => Log("UnhandledException: " + e.ExceptionObject);
        try { Run(wake); }
        catch (Exception ex) { Log("Run: " + ex); MessageBox.Show(ex.Message, "Harmonia", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        GC.KeepAlive(mutex);
    }

    static void Run(EventWaitHandle wake)
    {
        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch
        {
            if (MessageBox.Show("Harmonia needs the Microsoft Edge WebView2 Runtime, which is not installed.\n\nOpen the download page?",
                "Harmonia", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
            return;
        }

        Process server = null;
        if (!Up())
        {
            server = StartServer();
            for (int i = 0; i < 150 && !Up() && !server.HasExited; i++) Thread.Sleep(100);
            if (!Up())
            {
                MessageBox.Show("Harmonia's server did not start.\n\nLog: " + LogFile, "Harmonia", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }

        var web = new WebView2 { Dock = DockStyle.Fill };
        var form = new Form { Text = "Harmonia", StartPosition = FormStartPosition.CenterScreen, MinimumSize = new Size(640, 480),
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), BackColor = Color.FromArgb(0x16, 0x1D, 0x38) };
        form.Size = new Size(1280, 840);
        form.Controls.Add(web);
        LoadState(form);

        // The tray icon: closing the window leaves Harmonia running (Slack and the teammates keep working); Quit really quits.
        var tray = new NotifyIcon { Icon = form.Icon, Text = "Harmonia", Visible = true };
        Action open = () => { form.Show(); if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal; form.Activate(); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Harmonia", null, (s, e) => open());
        var startup = new ToolStripMenuItem("Start with Windows") { Checked = StartsWithWindows(), CheckOnClick = true };
        startup.CheckedChanged += (s, e) => SetStartsWithWindows(startup.Checked);
        menu.Items.Add(startup);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Harmonia", null, (s, e) => { quitting = true; form.Close(); });
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) open(); };
        bool told = File.Exists(Path.Combine(Data, "tray-told"));
        form.FormClosing += (s, e) =>
        {
            Log("closing: reason=" + e.CloseReason + " quitting=" + quitting);
            if (!quitting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true; SaveState(form); form.Hide();
                if (!told) { told = true; try { File.WriteAllText(Path.Combine(Data, "tray-told"), "1"); } catch { }
                    tray.ShowBalloonTip(4000, "Harmonia is still running", "It lives in the tray. Right-click the icon to quit.", ToolTipIcon.Info); }
            }
        };

        // A second launch brings this window forward.
        var waiter = new Thread(() => { while (wake.WaitOne()) { try { form.BeginInvoke(open); } catch { } } });
        waiter.IsBackground = true; waiter.Start();

        form.Shown += async (s, e) =>
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Data, "webview"));
                await web.EnsureCoreWebView2Async(env);
                var c = web.CoreWebView2;
                c.Settings.AreDevToolsEnabled = false;
                c.Settings.IsStatusBarEnabled = false;
                c.DocumentTitleChanged += (o, a) => { form.Text = string.IsNullOrEmpty(c.DocumentTitle) ? "Harmonia" : c.DocumentTitle; };
                c.NewWindowRequested += (o, a) => { a.Handled = true; Ext(a.Uri); };
                c.NavigationStarting += (o, a) => { if (!IsLocal(a.Uri)) { a.Cancel = true; Ext(a.Uri); } };
                c.ProcessFailed += (o, a) => { try { web.Reload(); } catch { } };
                web.Source = new Uri("http://localhost:" + Port);
            }
            catch (Exception ex) { MessageBox.Show("Could not start the Harmonia window.\n\n" + ex.Message, "Harmonia", MessageBoxButtons.OK, MessageBoxIcon.Error); quitting = true; form.Close(); }
        };
        form.FormClosing += (s, e) => SaveState(form);
        if (server != null)
        {
            var watched = server;
            new Thread(() =>
            {
                try
                {
                    watched.WaitForExit();
                    if (watched.ExitCode == RelaunchExit) { relaunch = true; quitting = true; form.BeginInvoke((Action)(() => form.Close())); }
                    else if (!quitting)
                    {
                        quitting = true;
                        form.BeginInvoke((Action)(() => { MessageBox.Show("Harmonia's server stopped unexpectedly, so Harmonia is closing.\n\nLog: " + LogFile, "Harmonia", MessageBoxButtons.OK, MessageBoxIcon.Error); form.Close(); }));
                    }
                }
                catch { }
            }) { IsBackground = true }.Start();
        }
        Application.Run(form);
        tray.Visible = false; tray.Dispose();
        if (relaunch)
        {
            // The update's files are in place; this build quits and the new Harmonia.exe takes over.
            try { Process.Start(new ProcessStartInfo(Path.Combine(BaseDir, "Harmonia.exe"), "--after " + Process.GetCurrentProcess().Id) { UseShellExecute = false }); } catch { }
            return;
        }
        try { if (server != null && !server.HasExited) { using (var k = Process.Start(new ProcessStartInfo("taskkill", "/F /T /PID " + server.Id) { CreateNoWindow = true, UseShellExecute = false })) k.WaitForExit(3000); } } catch { }
    }

    static volatile bool relaunch;
    static volatile bool quitting; // really quit (tray menu, an update, a failed start) instead of hiding to the tray

    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static bool StartsWithWindows()
    {
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue("Harmonia") != null; } catch { return false; }
    }
    static void SetStartsWithWindows(bool on)
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, true))
            { if (on) k.SetValue("Harmonia", "\"" + Path.Combine(BaseDir, "Harmonia.exe") + "\""); else k.DeleteValue("Harmonia", false); }
        }
        catch { }
    }
    static bool IsLocal(string u) { return u.StartsWith("http://localhost:" + Port) || u.StartsWith("http://127.0.0.1:" + Port) || u.StartsWith("about:") || u.StartsWith("data:") || u.StartsWith("blob:"); }
    static void Ext(string u) { if (u.StartsWith("http://") || u.StartsWith("https://") || u.StartsWith("mailto:")) try { Process.Start(new ProcessStartInfo(u) { UseShellExecute = true }); } catch { } }

    static void SaveState(Form f)
    {
        try
        {
            Directory.CreateDirectory(Data);
            var b = f.WindowState == FormWindowState.Normal ? f.Bounds : f.RestoreBounds;
            File.WriteAllText(StateFile, b.X + "," + b.Y + "," + b.Width + "," + b.Height + "," + (f.WindowState == FormWindowState.Maximized ? 1 : 0));
        }
        catch { }
    }
    static void LoadState(Form f)
    {
        try
        {
            var p = File.ReadAllText(StateFile).Split(',');
            var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
            foreach (var s in Screen.AllScreens)
                if (s.WorkingArea.IntersectsWith(r)) { f.StartPosition = FormStartPosition.Manual; f.Bounds = r; if (p[4] == "1") f.WindowState = FormWindowState.Maximized; return; }
        }
        catch { }
    }
}
