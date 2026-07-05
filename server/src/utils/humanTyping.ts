/**
 * humanTyping.ts
 */

export function humanDelay(): number {
  const base  = 40 + Math.random() * 80
  const pause = Math.random() < 0.1 ? 150 + Math.random() * 200 : 0
  return base + pause
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Type `text` into `locator` character-by-character using page-level keyboard.
 */
export async function humanType(
  locator: import('playwright').Locator,
  text: string,
  page?: import('playwright').Page,
): Promise<void> {
  console.log(`[humanType] "${text.slice(0, 40)}"${text.length > 40 ? '...' : ''} (${text.length} chars)`)

  await locator.click()
  console.log(`[humanType DEBUG] page exists: ${!!page}, url: ${page?.url()}`)
  await sleep(150 + Math.random() * 100)

  if (page) {
    await page.keyboard.press('Control+a')
    await sleep(60)
    await page.keyboard.press('Backspace')
    await sleep(80)

    for (const char of text) {
      await page.keyboard.type(char)
      await sleep(humanDelay())
    }
  } else {
    console.warn('[humanType] No page provided — falling back to pressSequentially (uniform delay)')
    await locator.pressSequentially(text, { delay: 65 })
  }

  console.log(`[humanType] Done`)
}

/**
 * Type into the currently-focused element on the page.
 */
export async function humanTypeIntoPage(
  page: import('playwright').Page,
  text: string,
): Promise<void> {
  console.log(`[humanTypeIntoPage] "${text.slice(0, 40)}" (${text.length} chars)`)

  for (const char of text) {
    await page.keyboard.type(char)
    await sleep(humanDelay())
  }

  console.log(`[humanTypeIntoPage] Done`)
}

/**
 * Write multi-line content into the currently-focused element.
 */
export async function humanWriteFile(
  page: import('playwright').Page,
  content: string,
): Promise<void> {
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    for (const char of lines[i]) {
      await page.keyboard.type(char)
      await sleep(humanDelay())
    }
    if (i < lines.length - 1) {
      await page.keyboard.press('Enter')
      await sleep(80 + Math.random() * 70)
    }
  }
}

/**
 * Build a PowerShell script that opens CMD visibly and runs a command.
 *
 * ROOT CAUSE OF PREVIOUS BUGS:
 *
 *   Bug 1 — "on is not recognized":
 *     The char-by-char loop sent characters before CMD was ready.
 *     CMD missed the first few chars "pyt" and only received "hon",
 *     making it run "thon" or "on" as a command.
 *
 *   Bug 2 — "thon is not recognized":
 *     Same timing issue — CMD window focus wasn't established before
 *     SendKeys started firing. The 1000ms wait wasn't enough.
 *
 *   Bug 3 — path spaces breaking the command:
 *     "python C:\Users\garv thakre\Desktop\file.py" — CMD splits on
 *     the space in "garv thakre" so python only receives "C:\Users\garv"
 *     as the file argument. Fix: wrap the path in double-quotes.
 *
 *   Bug 4 — here-string terminator crash (THE CURRENT BUG):
 *     The old approach used a PowerShell here-string (@'...'@) and put
 *     the command inside it via Set-Clipboard. PowerShell here-strings
 *     require the closing '@ to be on its OWN line with NOTHING before it.
 *     If the command string itself contained a newline followed by '@ —
 *     which can happen when the generated Python script has single-quoted
 *     strings like 'solid', 'FFFFFF', 'top', 'utf-8' etc. and those leak
 *     into the here-string — PowerShell terminates early and throws:
 *       "The string is missing the terminator: '@"
 *     This broke every Excel task that used parse_article() because the
 *     generated Python has many more single-quoted string literals.
 *
 * THE FIX — temp file approach:
 *   Instead of putting the command into a here-string, we write it to a
 *   temp .txt file using Out-File (which handles ALL special characters
 *   safely including single quotes, double quotes, backslashes, newlines).
 *   Then we read it back via Get-Content and Set-Clipboard, and paste
 *   into CMD with Ctrl+V. This is completely immune to quote/terminator
 *   issues because the command never appears inside a PowerShell string
 *   literal at all — it goes straight to disk and back.
 *
 *   On Windows, os.homedir() can contain spaces in the username
 *   (e.g. "C:\Users\garv thakre"). The path quoting logic below handles
 *   that by wrapping any path argument that contains spaces in double-quotes
 *   before the command is written to the temp file.
 */
export function buildVisibleCmdScript(command: string): string {
  // Step 1: Quote any unquoted path argument that contains spaces.
  // Matches: interpreter + unquoted argument with spaces
  // e.g. python C:\Users\garv thakre\Desktop\file.py
  //   => python "C:\Users\garv thakre\Desktop\make_excel.py"
  let fixedCommand = command.replace(
    /^(\s*(?:python3?|node|code|notepad|notepad2|subl|atom|gedit|kate)\s+)([^"\n]+)$/i,
    (_, interp, filePart) => {
      const trimmed = filePart.trim()
      // Already quoted — leave alone
      if (trimmed.startsWith('"')) return `${interp}${filePart}`
      // Has spaces — must quote
      if (trimmed.includes(' ')) return `${interp}"${trimmed}"`
      return `${interp}${filePart}`
    }
  )

  // Step 2: Write the command to a temp file instead of a here-string.
  //
  // WHY TEMP FILE:
  //   PowerShell here-strings (@'...'@) crash if the content contains
  //   a newline immediately followed by '@ — which generated Python scripts
  //   trigger because they have many single-quoted string literals.
  //   Out-File writes the raw string to disk with no quoting at all,
  //   so no special characters can break the PowerShell syntax.
  //
  // The temp file path uses a timestamp to avoid collisions between
  // concurrent NEXUS tasks. It is deleted after use to stay clean.

  const reviewPause = 400 + Math.floor(Math.random() * 200)

  // Escape the command for use inside a PowerShell double-quoted string
  // (only needed for the Out-File line — backslashes and double-quotes).
  // Single quotes do NOT need escaping inside double-quoted PS strings.
  const escapedForPs = fixedCommand
    .replace(/\\/g, '\\\\')   // backslash → double backslash
    .replace(/"/g, '\\"')     // double-quote → escaped double-quote

  const tmpFile = `$env:TEMP\\nexus_cmd_${Date.now()}.txt`

  const lines = [
    // Write command to temp file — safe for ALL special characters
    `"${escapedForPs}" | Out-File -FilePath "${tmpFile}" -Encoding utf8 -NoNewline`,
    // Read it back and put in clipboard
    `Set-Clipboard -Value (Get-Content -Path "${tmpFile}" -Raw)`,
    // Clean up temp file immediately
    `Remove-Item -Path "${tmpFile}" -Force -ErrorAction SilentlyContinue`,
    // Open CMD visibly
    `$wsh = New-Object -ComObject WScript.Shell`,
    `$proc = Start-Process cmd.exe -WindowStyle Normal -PassThru`,
    // Wait for CMD to fully open before sending keys
    `Start-Sleep -Milliseconds 2000`,
    `$wsh.AppActivate($proc.Id)`,
    `Start-Sleep -Milliseconds 600`,
    // Paste the command from clipboard — atomic, no char-by-char timing issues
    `$wsh.SendKeys('^v')`,
    `Start-Sleep -Milliseconds ${reviewPause}`,
    `$wsh.SendKeys('{ENTER}')`,
  ]

  return lines.join('; ')
}