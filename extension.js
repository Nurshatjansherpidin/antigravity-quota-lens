const vscode = require('vscode');
const { execSync } = require('child_process');
const https = require('https');

let statusBarItem;
let pollTimer = null;
let cachedPort = null;
let cachedCsrfToken = null;
let cachedPid = null;
let lastCombinedData = null;

/**
 * Discovers the running Antigravity language server process and its CSRF token.
 * Uses PowerShell Get-Process on Windows, ps aux on macOS/Linux.
 */
function findLanguageServer() {
  try {
    const isWindows = process.platform === 'win32';
    let lines = [];

    if (isWindows) {
      // PowerShell: Get all processes with their command lines
      const ps = execSync(
        'powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like \'*language_server*\'  -and $_.CommandLine -like \'*csrf_token*\' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
        { encoding: 'utf-8', timeout: 5000 }
      );
      if (!ps || ps.trim() === '' || ps.trim() === 'null') return null;
      const parsed = JSON.parse(ps.trim());
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const cmdLine = entry.CommandLine || '';
        const csrfMatch = cmdLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
        if (csrfMatch) {
          return { pid: String(entry.ProcessId), csrfToken: csrfMatch[1] };
        }
      }
    } else {
      // macOS / Linux
      const ps = execSync('ps aux', { encoding: 'utf-8', timeout: 3000 });
      lines = ps.split('\n').filter(l => l.includes('language_server') && l.includes('--csrf_token'));
      for (const line of lines) {
        const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
        const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
        if (pidMatch && csrfMatch) {
          return { pid: pidMatch[1], csrfToken: csrfMatch[1] };
        }
      }
    }
  } catch (err) {
    console.error('[Antigravity Quota] Error finding language server process:', err);
  }
  return null;
}

/**
 * Finds all active TCP listening ports for a given PID.
 * Uses netstat -ano on Windows, lsof on macOS/Linux.
 */
function findListeningPorts(pid) {
  try {
    const isWindows = process.platform === 'win32';
    const ports = [];

    if (isWindows) {
      // netstat -ano lists all TCP connections with PIDs
      const netstat = execSync('netstat -ano -p TCP', { encoding: 'utf-8', timeout: 3000 });
      const regex = /TCP\s+[\d.:]+:(\d+)\s+[\d.:]+\s+LISTENING\s+(\d+)/gi;
      let m;
      while ((m = regex.exec(netstat)) !== null) {
        if (String(m[2]) === String(pid)) {
          const p = parseInt(m[1], 10);
          if (!ports.includes(p)) ports.push(p);
        }
      }
    } else {
      // macOS / Linux
      const lsof = execSync(`lsof -a -p ${pid} -iTCP -sTCP:LISTEN -n -P`, { encoding: 'utf-8', timeout: 3000 });
      const matches = lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g);
      for (const m of matches) {
        const p = parseInt(m[1], 10);
        if (!ports.includes(p)) ports.push(p);
      }
    }
    return ports;
  } catch (err) {
    return [];
  }
}

/**
 * Sends an HTTPS request to an RPC endpoint on the local Language Server.
 */
function queryRpc(port, csrfToken, method, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ metadata: { ideName: 'antigravity' } });
    const req = https.request({
      hostname: '127.0.0.1',
      port: port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Codeium-Csrf-Token': csrfToken,
        'Connect-Protocol-Version': '1',
        'Content-Length': Buffer.byteLength(postData),
      },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        } else {
          reject(new Error(`Server returned HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Fetches combined user status and quota summary from the language server.
 */
async function fetchCombinedData(forceRediscover = false) {
  if (!forceRediscover && cachedPort && cachedCsrfToken) {
    try {
      const [quotaSummary, userStatus] = await Promise.all([
        queryRpc(cachedPort, cachedCsrfToken, 'RetrieveUserQuotaSummary'),
        queryRpc(cachedPort, cachedCsrfToken, 'GetUserStatus'),
      ]);
      return { quotaSummary, userStatus };
    } catch (err) {
      cachedPort = null;
      cachedCsrfToken = null;
      cachedPid = null;
    }
  }

  const ls = findLanguageServer();
  if (!ls) {
    throw new Error('Antigravity Language Server not detected. Is Antigravity IDE running?');
  }

  cachedCsrfToken = ls.csrfToken;
  cachedPid = ls.pid;

  const ports = findListeningPorts(ls.pid);
  if (ports.length === 0) {
    throw new Error(`No listening ports found for Antigravity Language Server (PID ${ls.pid}).`);
  }

  for (const port of ports) {
    try {
      const [quotaSummary, userStatus] = await Promise.all([
        queryRpc(port, cachedCsrfToken, 'RetrieveUserQuotaSummary', 1500),
        queryRpc(port, cachedCsrfToken, 'GetUserStatus', 1500),
      ]);
      if (quotaSummary && userStatus) {
        cachedPort = port;
        return { quotaSummary, userStatus };
      }
    } catch (e) {
      // Continue probing other candidate ports
    }
  }

  throw new Error('Failed to connect to Antigravity Language Server on discovered ports.');
}

/**
 * Generates an ASCII/Unicode progress bar.
 */
function makeProgressBar(fraction, totalBlocks = 10) {
  if (fraction === undefined || fraction === null) return '[----------]';
  const filled = Math.max(0, Math.min(totalBlocks, Math.round(fraction * totalBlocks)));
  const empty = totalBlocks - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * Calculates human-readable time remaining until an ISO timestamp.
 */
function formatTimeRemaining(isoDateString) {
  if (!isoDateString) return 'N/A';
  const diffMs = new Date(isoDateString).getTime() - Date.now();
  if (diffMs <= 0) return 'Resetting now';

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Updates the status bar item with 5-hour and weekly quota metrics.
 */
async function updateQuotaDisplay(showFeedback = false) {
  try {
    const config = vscode.workspace.getConfiguration('antigravityQuota');
    const displayFormat = config.get('displayFormat', 'both');
    const showCredits = config.get('showCredits', false);

    const data = await fetchCombinedData();
    lastCombinedData = data;

    const quotaResponse = data.quotaSummary?.response || {};
    const userStatus = data.userStatus?.userStatus || {};
    const groups = quotaResponse.groups || [];
    const planStatus = userStatus.planStatus || {};
    const userTier = userStatus.userTier || {};

    // Extract Gemini group
    const geminiGroup = groups.find(g => g.displayName.toLowerCase().includes('gemini')) || groups[0];
    const gemini5h = geminiGroup?.buckets?.find(b => b.window === '5h' || b.bucketId.includes('5h'));
    const geminiWk = geminiGroup?.buckets?.find(b => b.window === 'weekly' || b.bucketId.includes('weekly'));

    // Extract Claude / 3P group
    const claudeGroup = groups.find(g => g.displayName.toLowerCase().includes('claude'));
    const claude5h = claudeGroup?.buckets?.find(b => b.window === '5h' || b.bucketId.includes('5h'));
    const claudeWk = claudeGroup?.buckets?.find(b => b.window === 'weekly' || b.bucketId.includes('weekly'));

    const gem5hFrac = gemini5h?.remainingFraction !== undefined ? gemini5h.remainingFraction : 1.0;
    const gemWkFrac = geminiWk?.remainingFraction !== undefined ? geminiWk.remainingFraction : 1.0;

    const gem5hPct = Math.round(gem5hFrac * 100);
    const gemWkPct = Math.round(gemWkFrac * 100);

    const gem5hReset = formatTimeRemaining(gemini5h?.resetTime);
    const gemWkReset = formatTimeRemaining(geminiWk?.resetTime);

    const promptCredits = planStatus.availablePromptCredits ?? 'N/A';

    // Status bar icon
    const minFrac = Math.min(gem5hFrac, gemWkFrac);
    let icon = '$(dashboard)';
    if (minFrac > 0.6) icon = '$(check)';
    else if (minFrac > 0.25) icon = '$(pulse)';
    else icon = '$(warning)';

    // Format text according to settings
    let text = '';
    switch (displayFormat) {
      case 'compactBoth':
        text = `${icon} 5h: ${gem5hPct}% | Wk: ${gemWkPct}%`;
        break;
      case '5hOnly':
        text = `${icon} Gemini 5h: ${gem5hPct}% (${gem5hReset})`;
        break;
      case 'weeklyOnly':
        text = `${icon} Gemini Wk: ${gemWkPct}% (${gemWkReset})`;
        break;
      case 'both':
      default:
        text = `${icon} Gemini 5h: ${gem5hPct}% (${gem5hReset}) | Wk: ${gemWkPct}% (${gemWkReset})`;
        break;
    }

    if (showCredits && promptCredits !== 'N/A') {
      text += ` | ${promptCredits} Credits`;
    }

    statusBarItem.text = text;

    // Background color coding
    if (minFrac <= 0.20) {
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (minFrac <= 0.40) {
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBarItem.backgroundColor = undefined;
    }

    // Build rich Markdown Tooltip
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const tierName = userTier.name || 'Google AI Pro';
    const statusDot = minFrac > 0.5 ? '🟢 Healthy' : minFrac > 0.2 ? '🟡 Warning' : '🔴 Low Quota';

    md.appendMarkdown(`### ⚡ Antigravity Token & Quota Monitor\n\n`);
    md.appendMarkdown(`**Plan Tier:** ${tierName} &nbsp;|&nbsp; **Status:** ${statusDot}\n\n`);
    md.appendMarkdown(`---\n\n`);

    // Gemini Group Breakdown
    md.appendMarkdown(`#### 🔷 Gemini Models (Flash & Pro)\n`);
    md.appendMarkdown(`- **⏱️ 5-Hour Sprint Limit:** \`${gem5hPct}%\` &nbsp; ${makeProgressBar(gem5hFrac, 10)}\n`);
    md.appendMarkdown(`  - *Resets in:* \`${gem5hReset}\` *(Countdown to rolling 5-hour refresh)*\n`);
    md.appendMarkdown(`- **📅 Weekly Baseline Limit:** \`${gemWkPct}%\` &nbsp; ${makeProgressBar(gemWkFrac, 10)}\n`);
    md.appendMarkdown(`  - *Resets in:* \`${gemWkReset}\` *(Full weekly reset)*\n`);
    if (geminiWk?.description) {
      md.appendMarkdown(`  - *Note:* ${geminiWk.description}\n`);
    }
    md.appendMarkdown(`\n`);

    // Claude & GPT Group Breakdown
    if (claudeGroup && claude5h && claudeWk) {
      const c5hFrac = claude5h.remainingFraction ?? 1;
      const cWkFrac = claudeWk.remainingFraction ?? 1;
      const c5hPct = Math.round(c5hFrac * 100);
      const cWkPct = Math.round(cWkFrac * 100);
      const c5hReset = formatTimeRemaining(claude5h.resetTime);
      const cWkReset = formatTimeRemaining(claudeWk.resetTime);

      md.appendMarkdown(`#### 🟣 Claude & GPT Models (Opus, Sonnet, GPT-OSS)\n`);
      md.appendMarkdown(`- **⏱️ 5-Hour Limit:** \`${c5hPct}%\` &nbsp; ${makeProgressBar(c5hFrac, 10)} *(Resets in ${c5hReset})*\n`);
      md.appendMarkdown(`- **📅 Weekly Limit:** \`${cWkPct}%\` &nbsp; ${makeProgressBar(cWkFrac, 10)} *(Resets in ${cWkReset})*\n\n`);
    }

    // Credits
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`#### 💳 Account Credits & Pool\n`);
    md.appendMarkdown(`- **Available Prompt Credits:** \`${promptCredits}\`\n`);
    md.appendMarkdown(`- **Available Flow Credits:** \`${planStatus.availableFlowCredits ?? 'N/A'}\`\n`);
    if (planStatus.planInfo?.monthlyPromptCredits) {
      md.appendMarkdown(`- **Monthly Allocation:** \`${planStatus.planInfo.monthlyPromptCredits.toLocaleString()}\` Prompt Credits\n`);
    }

    md.appendMarkdown(`\n---\n\n`);
    md.appendMarkdown(`[🔄 Refresh Quota](command:antigravityQuota.refresh) &nbsp;|&nbsp; [⚙️ Monitor Settings](command:workbench.action.openSettings?%22antigravityQuota%22)\n`);

    statusBarItem.tooltip = md;
    statusBarItem.show();

    if (showFeedback) {
      vscode.window.showInformationMessage(`Antigravity Quotas: Gemini 5-Hour: ${gem5hPct}% (${gem5hReset}), Weekly: ${gemWkPct}% (${gemWkReset})`);
    }
  } catch (err) {
    statusBarItem.text = `$(warning) Quota: Offline`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.tooltip = `Antigravity Quota Monitor could not connect:\n${err.message}\n\nClick to retry.`;
    statusBarItem.show();

    if (showFeedback) {
      vscode.window.showErrorMessage(`Antigravity Quota error: ${err.message}`);
    }
  }
}

/**
 * Shows an interactive QuickPick menu when clicking the status bar item.
 */
async function showQuotaDetailsMenu() {
  if (!lastCombinedData) {
    await updateQuotaDisplay(false);
  }

  const quotaResponse = lastCombinedData?.quotaSummary?.response || {};
  const groups = quotaResponse.groups || [];
  const geminiGroup = groups.find(g => g.displayName.toLowerCase().includes('gemini'));
  const gemini5h = geminiGroup?.buckets?.find(b => b.window === '5h' || b.bucketId.includes('5h'));
  const geminiWk = geminiGroup?.buckets?.find(b => b.window === 'weekly' || b.bucketId.includes('weekly'));

  const gem5hPct = Math.round((gemini5h?.remainingFraction ?? 1) * 100);
  const gemWkPct = Math.round((geminiWk?.remainingFraction ?? 1) * 100);

  const items = [
    {
      label: '$(sync) Refresh Quota Now',
      description: 'Fetch latest 5-hour and weekly token limits',
      action: 'refresh',
    },
    {
      label: '$(layout) Change Status Bar Display Format...',
      description: 'Toggle between Both (5h & Wk), Compact, 5h Only, or Weekly Only',
      action: 'switch_format',
    },
    {
      label: '$(clippy) Copy Detailed Quota Report to Clipboard',
      description: 'Copy markdown summary with all limits and countdowns',
      action: 'copy',
    },
    {
      label: '$(gear) Extension Settings',
      description: 'Configure polling interval and display options',
      action: 'settings',
    },
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: 'Gemini Quota Status',
    },
    {
      label: `$(clock) 5-Hour Sprint Quota: ${gem5hPct}%`,
      description: `Resets in: ${formatTimeRemaining(gemini5h?.resetTime)}`,
      action: 'none',
    },
    {
      label: `$(calendar) Weekly Baseline Limit: ${gemWkPct}%`,
      description: `Resets in: ${formatTimeRemaining(geminiWk?.resetTime)}`,
      action: 'none',
    },
  ];

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Antigravity Quota & Token Monitor Actions',
  });

  if (!selection) return;

  if (selection.action === 'refresh') {
    await updateQuotaDisplay(true);
  } else if (selection.action === 'switch_format') {
    const formatOptions = [
      { label: 'both', description: 'Full: Gemini 5h: 88% (4h 32m) | Wk: 64% (5d 11h)' },
      { label: 'compactBoth', description: 'Compact: 5h: 88% | Wk: 64%' },
      { label: '5hOnly', description: '5-Hour Only: Gemini 5h: 88% (4h 32m)' },
      { label: 'weeklyOnly', description: 'Weekly Only: Gemini Wk: 64% (5d 11h)' },
    ];
    const chosen = await vscode.window.showQuickPick(formatOptions, {
      placeHolder: 'Choose display format for status bar',
    });
    if (chosen) {
      await vscode.workspace.getConfiguration('antigravityQuota').update('displayFormat', chosen.label, vscode.ConfigurationTarget.Global);
      await updateQuotaDisplay(false);
    }
  } else if (selection.action === 'copy') {
    await copyQuotaSummary();
  } else if (selection.action === 'settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityQuota');
  }
}

/**
 * Copies a markdown summary of quota status to the clipboard.
 */
async function copyQuotaSummary() {
  if (!lastCombinedData) {
    await updateQuotaDisplay(false);
  }

  const quotaResponse = lastCombinedData?.quotaSummary?.response || {};
  const userStatus = lastCombinedData?.userStatus?.userStatus || {};
  const groups = quotaResponse.groups || [];
  const planStatus = userStatus.planStatus || {};
  const userTier = userStatus.userTier || {};

  let text = `# Antigravity Quota Report\n`;
  text += `**Generated:** ${new Date().toLocaleString()}\n`;
  text += `**Plan Tier:** ${userTier.name || 'Google AI Pro'}\n`;
  text += `**Prompt Credits:** ${planStatus.availablePromptCredits ?? 0} | **Flow Credits:** ${planStatus.availableFlowCredits ?? 0}\n\n`;

  for (const group of groups) {
    text += `## ${group.displayName}\n`;
    for (const bucket of group.buckets || []) {
      const pct = Math.round((bucket.remainingFraction ?? 1) * 100);
      const time = formatTimeRemaining(bucket.resetTime);
      text += `- **${bucket.displayName} (${bucket.window}):** ${pct}% remaining (Resets in: ${time})\n`;
    }
    text += `\n`;
  }

  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Antigravity Quota summary copied to clipboard!');
}

/**
 * Sets up background polling interval.
 */
function setupPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  const config = vscode.workspace.getConfiguration('antigravityQuota');
  const intervalSeconds = Math.max(5, config.get('pollingInterval', 30));

  pollTimer = setInterval(() => {
    updateQuotaDisplay(false);
  }, intervalSeconds * 1000);
}

/**
 * Extension activation entrypoint.
 */
function activate(context) {
  const config = vscode.workspace.getConfiguration('antigravityQuota');
  const priority = config.get('statusBarPriority', 100);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    priority
  );
  statusBarItem.command = 'antigravityQuota.showDetails';
  statusBarItem.text = '$(pulse) Quota: Initializing...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityQuota.refresh', () => updateQuotaDisplay(true)),
    vscode.commands.registerCommand('antigravityQuota.showDetails', showQuotaDetailsMenu),
    vscode.commands.registerCommand('antigravityQuota.copySummary', copyQuotaSummary)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityQuota')) {
        setupPolling();
        updateQuotaDisplay(false);
      }
    })
  );

  updateQuotaDisplay(false);
  setupPolling();
}

/**
 * Extension deactivation entrypoint.
 */
function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  activate,
  deactivate,
};
