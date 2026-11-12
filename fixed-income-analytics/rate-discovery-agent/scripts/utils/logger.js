/**
 * Structured logger with 5 levels and streaming file output.
 *
 * - Console: error→stderr, warn/info/debug→stdout, trace→file only
 * - File: all enabled levels stream to a WriteStream (constant memory)
 * - isEnabled(lvl): cheap guard to skip expensive argument preparation
 *
 * Usage:
 *   const { createLogger } = require("./utils/logger");
 *   const log = createLogger("warn");          // default level
 *   log.setLogFile("output/runs/.../bank.log"); // open file stream
 *   log.info("Starting discovery for", bankName);
 *   if (log.isEnabled("trace")) log.trace("HTML:", hugeString);
 *   log.flush();                                // close file stream
 */

const fs = require("fs");

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/**
 * Create a logger instance.
 * @param {string} level - Minimum log level ("error"|"warn"|"info"|"debug"|"trace")
 * @returns {object} Logger instance
 */
function createLogger(level = "warn") {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.warn;

  // Small buffer for messages logged before setLogFile() is called.
  // Once the file stream opens, this is drained and cleared.
  let earlyBuffer = [];
  let fileStream = null;

  function formatLine(lvl, args) {
    const ts = new Date().toISOString();
    const tag = lvl.toUpperCase().padEnd(5);
    const msg = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    return `[${ts}] [${tag}] ${msg}`;
  }

  function writeToFile(text) {
    if (fileStream) {
      fileStream.write(text + "\n");
    } else {
      earlyBuffer.push(text);
    }
  }

  function log(lvl, ...args) {
    if ((LOG_LEVELS[lvl] ?? 0) > threshold) return;
    const line = formatLine(lvl, args);

    // Console output: trace goes to file only, error to stderr, rest to stdout
    if (lvl === "error") {
      process.stderr.write(line + "\n");
    } else if (lvl !== "trace") {
      process.stdout.write(line + "\n");
    }

    // File output: all enabled levels
    writeToFile(line);
  }

  return {
    error: (...args) => log("error", ...args),
    warn: (...args) => log("warn", ...args),
    info: (...args) => log("info", ...args),
    debug: (...args) => log("debug", ...args),
    trace: (...args) => log("trace", ...args),

    /**
     * Check if a level is enabled — use to guard expensive argument preparation.
     *   if (log.isEnabled("trace")) log.trace("HTML:", hugeString);
     * @param {string} lvl
     * @returns {boolean}
     */
    isEnabled(lvl) {
      return (LOG_LEVELS[lvl] ?? 0) <= threshold;
    },

    /**
     * Open a file stream for log output. Drains any early-buffered messages.
     * Call this once the run directory and log file path are known.
     * @param {string} logFile - Absolute path to the log file
     */
    setLogFile(logFile) {
      if (fileStream) return; // already open
      fs.mkdirSync(require("path").dirname(logFile), { recursive: true });
      fileStream = fs.createWriteStream(logFile, { flags: "w", encoding: "utf-8" });
      // Drain early buffer
      for (const line of earlyBuffer) {
        fileStream.write(line + "\n");
      }
      earlyBuffer = [];
    },

    /** Append raw text (e.g., agent output) to the log file without formatting. */
    appendRaw(text) {
      writeToFile(text);
    },

    /**
     * Close the file stream. Call at the end of the run.
     * For backward compatibility, also accepts a logFile path — if no stream
     * is open, writes early buffer to that file (legacy flush behavior).
     * @param {string} [logFile] - Optional path for legacy callers
     */
    flush(logFile) {
      if (fileStream) {
        fileStream.end();
        fileStream = null;
      } else if (logFile && earlyBuffer.length > 0) {
        // Legacy fallback: no stream was opened, write buffer to file
        fs.mkdirSync(require("path").dirname(logFile), { recursive: true });
        // safe-write-exempt: .log file legacy buffer flush (operational by-product, not per-bank artifact).
        fs.writeFileSync(logFile, earlyBuffer.join("\n") + "\n", "utf-8");
      }
      earlyBuffer = [];
    },

    /** Get the current log level name. */
    get level() {
      return level;
    },
  };
}

module.exports = { createLogger, LOG_LEVELS };
