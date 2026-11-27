// Staffroom Gazette Windows service.
//
// A small wrapper that lets the Gazette (a Node.js program) run as a proper
// Windows service. It starts the bundled node.exe with server.js, restarts it
// if it ever exits, and stops it when the service stops. A Windows job object
// makes sure node.exe can never outlive the service.
//
// Settings come from HKLM\SOFTWARE\Staffroom Gazette (written by the MSI):
//   Port     (string)  port to listen on, default 3000
//   DataDir  (string)  folder for notices, uploads and logs,
//                      default %ProgramData%\Staffroom Gazette
//
// Layout expected next to this exe:
//   node\node.exe      app\server.js
//
// Build (no SDK needed, uses the C# compiler that ships with Windows):
//   csc /target:exe /platform:x64 /out:StaffroomGazetteService.exe /reference:System.ServiceProcess.dll GazetteService.cs
//
// Run in a console for testing:  StaffroomGazetteService.exe --console [--port 3000] [--data "C:\some\folder"]
// (--port and --data override the registry settings, for troubleshooting.)
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;

namespace StaffroomGazette
{
    public sealed class GazetteService : ServiceBase
    {
        public const string Name = "StaffroomGazette";
        const string RegistryPath = @"SOFTWARE\Staffroom Gazette";

        readonly object gate = new object();
        readonly ManualResetEvent stopping = new ManualResetEvent(false);
        Thread supervisor;
        Process node;
        IntPtr job = IntPtr.Zero;
        string logFile;
        string portOverride;
        string dataOverride;

        public GazetteService()
        {
            ServiceName = Name;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        public static int Main(string[] args)
        {
            if (args.Length > 0 && args[0].Equals("--console", StringComparison.OrdinalIgnoreCase))
            {
                var service = new GazetteService();
                for (int i = 1; i < args.Length - 1; i++)
                {
                    if (args[i] == "--port") service.portOverride = args[i + 1];
                    if (args[i] == "--data") service.dataOverride = args[i + 1];
                }
                service.OnStart(args);
                if (Console.IsInputRedirected)
                {
                    // Scripted/test runs: keep going until the process is ended.
                    Console.WriteLine("Staffroom Gazette is running (input redirected; end the process to stop).");
                    Thread.Sleep(Timeout.Infinite);
                }
                Console.WriteLine("Staffroom Gazette is running. Press Enter to stop.");
                Console.ReadLine();
                service.OnStop();
                return 0;
            }
            ServiceBase.Run(new GazetteService());
            return 0;
        }

        // ------------------------------------------------------------------
        // Service lifecycle
        // ------------------------------------------------------------------

        protected override void OnStart(string[] args)
        {
            stopping.Reset();
            job = CreateKillOnCloseJob();
            supervisor = new Thread(Supervise) { IsBackground = true, Name = "Gazette supervisor" };
            supervisor.Start();
        }

        protected override void OnStop()
        {
            stopping.Set();
            KillNode();
            if (supervisor != null) supervisor.Join(10000);
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            Log("Service stopped.");
        }

        protected override void OnShutdown()
        {
            OnStop();
        }

        // Keep node.exe running; restart it (with a growing pause) if it exits.
        void Supervise()
        {
            int delaySeconds = 2;
            while (!stopping.WaitOne(0))
            {
                DateTime started = DateTime.UtcNow;
                try
                {
                    StartNode();
                    node.WaitForExit();
                    if (stopping.WaitOne(0)) break;
                    Log("The Gazette stopped unexpectedly (exit code " + node.ExitCode + "). Restarting in " + delaySeconds + " s.");
                }
                catch (Exception ex)
                {
                    Log("Could not start the Gazette: " + ex.Message + ". Retrying in " + delaySeconds + " s.");
                }
                // If it ran for a while, it wasn't a start-up crash loop: reset the pause.
                if ((DateTime.UtcNow - started).TotalMinutes > 5) delaySeconds = 2;
                if (stopping.WaitOne(TimeSpan.FromSeconds(delaySeconds))) break;
                delaySeconds = Math.Min(delaySeconds * 2, 60);
            }
        }

        void StartNode()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string nodeExe = Path.Combine(baseDir, @"node\node.exe");
            string appDir = Path.Combine(baseDir, "app");
            string server = Path.Combine(appDir, "server.js");
            if (!File.Exists(nodeExe)) throw new FileNotFoundException("node.exe not found", nodeExe);
            if (!File.Exists(server)) throw new FileNotFoundException("server.js not found", server);

            string port = "3000";
            string dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Staffroom Gazette");
            using (var key = Registry.LocalMachine.OpenSubKey(RegistryPath))
            {
                if (key != null)
                {
                    var p = key.GetValue("Port") as string;
                    var d = key.GetValue("DataDir") as string;
                    if (!string.IsNullOrWhiteSpace(p)) port = p.Trim();
                    if (!string.IsNullOrWhiteSpace(d)) dataDir = d.Trim();
                }
            }
            if (!string.IsNullOrEmpty(portOverride)) port = portOverride;
            if (!string.IsNullOrEmpty(dataOverride)) dataDir = dataOverride;
            string logs = Path.Combine(dataDir, "logs");
            Directory.CreateDirectory(Path.Combine(dataDir, "data"));
            Directory.CreateDirectory(logs);
            logFile = Path.Combine(logs, "service.log");

            var psi = new ProcessStartInfo(nodeExe, Quote(server))
            {
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.EnvironmentVariables["PORT"] = port;
            psi.EnvironmentVariables["DATA_DIR"] = Path.Combine(dataDir, "data");
            psi.EnvironmentVariables["LOG_FILE"] = Path.Combine(logs, "gazette.log");

            lock (gate)
            {
                node = new Process { StartInfo = psi };
                // The server writes its own log file; just drain the pipes so they never fill up.
                node.OutputDataReceived += (s, e) => { };
                node.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("node: " + e.Data); };
                node.Start();
                if (job != IntPtr.Zero) AssignProcessToJobObject(job, node.Handle);
                node.BeginOutputReadLine();
                node.BeginErrorReadLine();
                // A stop that arrived while node was starting: don't leave it running.
                if (stopping.WaitOne(0)) { try { node.Kill(); } catch { } return; }
            }
            Log("Started the Gazette on port " + port + " (data: " + dataDir + ").");
        }

        void KillNode()
        {
            lock (gate)
            {
                try { if (node != null && !node.HasExited) { node.Kill(); node.WaitForExit(5000); } }
                catch { /* already gone */ }
            }
        }

        void Log(string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message;
            if (Environment.UserInteractive) Console.WriteLine(line);
            try { if (logFile != null) File.AppendAllText(logFile, line + Environment.NewLine); }
            catch { /* logging must never stop the service */ }
        }

        static string Quote(string s)
        {
            return "\"" + s + "\"";
        }

        // ------------------------------------------------------------------
        // Job object: closing the handle (service exit, even a crash) kills node.exe
        // ------------------------------------------------------------------

        static IntPtr CreateKillOnCloseJob()
        {
            IntPtr handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(handle, 9 /* JobObjectExtendedLimitInformation */, ptr, (uint)size);
            }
            finally { Marshal.FreeHGlobal(ptr); }
            return handle;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll")]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
    }
}
