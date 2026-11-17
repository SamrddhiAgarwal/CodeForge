import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { OUTPUT_LIMIT, type ExecutionJob, type ExecutionResult } from '@codeforge/execution';

// Only this trusted process talks to Docker. Submitted programs receive no mounts or host environment.
const dockerArgs = ['--config', '/nonexistent-codeforge-config', '--host', 'unix:///var/run/docker.sock'];
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin' };
const label = 'codeforge.runner=true';
const imagePrefix = process.env.RUNNER_IMAGE_PREFIX ?? 'codeforge-runner';
const imageTag = process.env.RUNNER_IMAGE_TAG ?? '1';
if (!/^[a-z0-9][a-z0-9._/-]*$/.test(imagePrefix) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(imageTag)) {
  throw new Error('Invalid runner image configuration.');
}

function docker(args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', [...dockerArgs, ...args], { env: environment, timeout, maxBuffer: 128 * 1024 }, (error, stdout) => {
      // Do not expose Docker diagnostics, host paths, or configuration to users.
      if (error) reject(new Error('Execution infrastructure is unavailable. Check the worker and runner images.'));
      else resolve(stdout.trim());
    });
  });
}

export async function cleanupStaleContainers(scope: string) {
  const ids = await docker(['ps', '-aq', '--filter', `label=${label}`, '--filter', `label=codeforge.scope=${scope}`]);
  for (const id of ids.split('\n').filter(Boolean)) await docker(['rm', '-f', '-v', id]);
}

export async function runCode(job: ExecutionJob, scope: string): Promise<ExecutionResult> {
  const name = `codeforge-${randomUUID()}`;
  const timeLimit = job.language === 'cpp' ? 15_000 : 5_000;
  let created = false;
  const started = Date.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let outputLimited = false;
  let stopping: Promise<string> | undefined;
  const stop = () => { stopping ??= docker(['kill', name]).catch(() => ''); };
  try {
    await docker(['create', '--pull=never', '--name', name,
      '--label', label, '--label', `codeforge.scope=${scope}`,
      '--network', 'none', '--user', '10001:10001', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '64',
      '--ulimit', 'nofile=64:64', '--ulimit', 'core=0:0', '--log-driver', 'none', '--restart', 'no',
      '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=64m,mode=1777',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
      '-i', `${imagePrefix}-${job.language}:${imageTag}`]);
    created = true;
    const runStarted = Date.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', [...dockerArgs, 'start', '-a', '-i', name], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeLimit + 1500);
      // Bound the Docker client too, even if the daemon stops responding.
      const clientTimer = setTimeout(() => { timedOut = true; stop(); child.kill('SIGKILL'); }, timeLimit + 12_000);
      const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        const remaining = Math.max(0, OUTPUT_LIMIT - stdout.length - stderr.length);
        if (stream === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
        else stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
        if (chunk.length > remaining) { outputLimited = true; stop(); }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
      child.stdin.on('error', () => { /* The process may exit before consuming all input. */ });
      child.stdin.end(job.code);
      child.once('error', () => { clearTimeout(timer); clearTimeout(clientTimer); reject(new Error('Could not start the Docker client.')); });
      child.once('close', () => { clearTimeout(timer); clearTimeout(clientTimer); resolve(); });
    });
    await stopping;
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name])) as { Status: string; ExitCode: number; OOMKilled: boolean };
    if (state.Status !== 'exited') throw new Error('Runner did not finish normally.');
    // The fixed image entrypoint uses GNU timeout, with a host watchdog as a fallback.
    if (!outputLimited && !state.OOMKilled && state.ExitCode === 137 && Date.now() - runStarted >= timeLimit - 100) timedOut = true;
    return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: state.ExitCode,
      timedOut, outputLimited, memoryLimited: state.OOMKilled, durationMs: Date.now() - started };
  } finally {
    // Also attempt cleanup after a create timeout: Docker might have created the container already.
    if (created) await docker(['rm', '-f', '-v', name]);
    else await docker(['rm', '-f', '-v', name]).catch(() => {});
  }
}
