import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import fg from "fast-glob";
import { z } from "zod";

export const read_file = {
  name: "read_file",
  description: "Read contents of a file, optionally a 1-based inclusive line range.",
  schema: z.object({
    path: z.string().describe("Path to the file"),
    start_line: z.number().optional().describe("Starting line (1-indexed). Omit to read from the beginning."),
    end_line: z.number().optional().describe("Ending line (1-indexed). Omit to read to the end."),
  }),
  execute: ({ path, start_line, end_line }) => {
    try {
      const lines = readFileSync(resolve(process.cwd(), path), "utf-8").split("\n");
      const start = start_line ? start_line - 1 : 0;
      const end = end_line ?? lines.length;
      return lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
    } catch (error) {
      return `Error reading file: ${error.message}`;
    }
  },
};

export const write_file = {
  name: "write_file",
  description: "Write content to a file, creating or overwriting it.",
  schema: z.object({
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write"),
  }),
  execute: ({ path, content }) => {
    try {
      writeFileSync(resolve(process.cwd(), path), content, "utf-8");
      return `Wrote ${path}`;
    } catch (error) {
      return `Error writing file: ${error.message}`;
    }
  },
};

export const edit_file = {
  name: "edit_file",
  description: "Replace a 1-based inclusive line range in a file with new content.",
  schema: z.object({
    path: z.string().describe("Path to the file"),
    start_line: z.number().describe("First line to replace (1-indexed)"),
    end_line: z.number().describe("Last line to replace (1-indexed)"),
    new_content: z.string().describe("Replacement content"),
  }),
  execute: ({ path, start_line, end_line, new_content }) => {
    const fullPath = resolve(process.cwd(), path);
    const lines = readFileSync(fullPath, "utf-8").split("\n");

    if (start_line < 1 || start_line > lines.length) {
      throw new Error(`start_line ${start_line} out of range (file has ${lines.length} lines)`);
    }
    if (end_line < start_line || end_line > lines.length) {
      throw new Error(`end_line ${end_line} must be between start_line and ${lines.length}`);
    }

    const result = [...lines.slice(0, start_line - 1), new_content, ...lines.slice(end_line)].join("\n");
    writeFileSync(fullPath, result, "utf-8");
    const count = end_line - start_line + 1;
    return `Edited ${path} (replaced ${count} line${count > 1 ? "s" : ""})`;
  },
};

export const delete_file = {
  name: "delete_file",
  description: "Delete a file.",
  schema: z.object({ path: z.string().describe("Path to the file to delete") }),
  execute: ({ path }) => {
    try {
      unlinkSync(resolve(process.cwd(), path));
      return `Deleted ${path}`;
    } catch (error) {
      return `Error deleting file: ${error.message}`;
    }
  },
};

export const list_directory = {
  name: "list_directory",
  description: "List the contents of a directory (non-recursive).",
  schema: z.object({ path: z.string().describe("Path to the directory") }),
  execute: ({ path }) => {
    try {
      return readdirSync(path)
        .map((entry) => `${statSync(join(path, entry)).isDirectory() ? "[DIR] " : "[FILE]"} ${entry}`)
        .join("\n");
    } catch (error) {
      return `Error listing directory: ${error.message}`;
    }
  },
};

export const glob = {
  name: "glob",
  description: "Match files by glob pattern (e.g. **/*.js).",
  schema: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Directory to search. Omit for the current directory."),
  }),
  execute: ({ pattern, path }) => {
    try {
      const cwd = path ? resolve(process.cwd(), path) : process.cwd();
      const files = fg.sync(pattern, { cwd, dot: true });
      return files.length > 0 ? files.join("\n") : "No files matched";
    } catch (error) {
      return `Error matching pattern: ${error.message}`;
    }
  },
};

export const grep = {
  name: "grep",
  description: "Search file contents with a regex. Uses ripgrep when available, otherwise grep.",
  schema: z.object({
    pattern: z.string().describe("Regular expression to search for"),
    path: z.string().optional().describe("File or directory to search. Defaults to the current directory."),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .optional()
      .describe("content shows lines, files_with_matches shows paths, count shows counts. Default files_with_matches."),
  }),
  execute: ({ pattern, path = ".", output_mode = "files_with_matches" }) => {
    let cmd = "grep";
    try {
      execSync("which rg", { stdio: "ignore" });
      cmd = "rg";
    } catch {
      // ripgrep not installed, fall back to grep
    }

    const flags = [cmd === "grep" ? "-r" : ""];
    if (output_mode === "files_with_matches") flags.push("-l");
    if (output_mode === "count") flags.push("-c");

    try {
      const result = execSync(`${cmd} ${flags.join(" ")} '${pattern}' ${path}`, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return result.trim() || "No matches found";
    } catch (error) {
      if (error.status === 1) return "No matches found";
      return `Error searching: ${error.message}`;
    }
  },
};

export const bash = {
  name: "bash",
  description: "Execute a shell command.",
  schema: z.object({
    command: z.string().describe("The command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds (max 120000). Default 120000."),
  }),
  execute: ({ command, timeout = 120000 }) => {
    try {
      const result = execSync(command, {
        encoding: "utf-8",
        timeout: Math.min(timeout, 120000),
        maxBuffer: 10 * 1024 * 1024,
      });
      return result.trim() || "Command executed (no output)";
    } catch (error) {
      return `Error executing command: ${error.message}\n${error.stderr || ""}`.trim();
    }
  },
};
