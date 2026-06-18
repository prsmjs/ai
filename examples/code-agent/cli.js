import readline from "readline";

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const DANGEROUS = new Set(["delete_file", "bash", "edit_file", "write_file"]);

export const createCli = (createWorkflow, thread) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}>${C.reset} `,
  });

  let abortController = null;
  let processing = false;
  const approvalQueue = [];

  const processNextApproval = () => {
    const { toolCall, resolve } = approvalQueue[0];
    const args = JSON.parse(toolCall.function.arguments);
    console.log(`\n${"-".repeat(50)}`);
    console.log(`tool: ${toolCall.function.name}`);
    console.log(`args: ${JSON.stringify(args, null, 2)}`);
    console.log("-".repeat(50));

    rl.question("approve? (y/n): ", (answer) => {
      resolve(answer.trim().toLowerCase() === "y");
      approvalQueue.shift();
      if (approvalQueue.length > 0) processNextApproval();
    });
  };

  const askApproval = (toolCall) =>
    new Promise((resolve) => {
      approvalQueue.push({ toolCall, resolve });
      if (approvalQueue.length === 1) processNextApproval();
    });

  const approvalCallback = (toolCall) =>
    DANGEROUS.has(toolCall.function.name) ? askApproval(toolCall) : true;

  const stream = (event) => {
    switch (event.type) {
      case "content":
        process.stdout.write(C.green + event.content + C.reset);
        break;
      case "tool_executing":
        process.stdout.write(
          `${C.yellow}\n[${event.call.function.name} ${event.call.function.arguments}]${C.reset}\n`,
        );
        break;
      case "tool_complete": {
        const result = event.result ? String(event.result) : "";
        const lines = result.split("\n");
        const preview = lines.length > 8 ? `${lines.slice(0, 8).join("\n")}\n+${lines.length - 8} more lines` : result;
        process.stdout.write(`${C.yellow}[done]${C.reset} ${preview}\n`);
        break;
      }
      case "tool_error":
        process.stdout.write(`${C.red}[${event.call.function.name} failed: ${event.error}]${C.reset}\n`);
        break;
    }
  };

  const processMessage = async (message) => {
    processing = true;
    abortController = new AbortController();
    try {
      await thread.message(message, createWorkflow(stream, approvalCallback, abortController.signal));
      console.log();
    } catch (error) {
      console.log(error.name === "AbortError" ? "\n[canceled]" : `\n${C.red}error: ${error.message}${C.reset}`);
    } finally {
      abortController = null;
      processing = false;
      rl.prompt();
    }
  };

  // esc cancels an in-flight turn
  process.stdin.on("data", (data) => {
    if (data[0] === 27 && processing && abortController) abortController.abort();
  });

  rl.on("line", (line) => {
    const message = line.trim();
    if (message) processMessage(message);
    else rl.prompt();
  });

  rl.on("close", () => {
    console.log();
    process.exit(0);
  });

  rl.prompt();
};
