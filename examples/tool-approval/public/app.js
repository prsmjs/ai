const threadId = Math.random().toString(36).slice(2, 9);
const messages = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

const addMessage = (role, content = "") => {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<span class="role"></span><span class="body"></span>`;
  div.querySelector(".role").textContent = role;
  div.querySelector(".body").textContent = content;
  messages.append(div);
  messages.scrollTop = messages.scrollHeight;
  return div.querySelector(".body");
};

const addTool = (text) => {
  const div = document.createElement("div");
  div.className = "tool";
  div.textContent = text;
  messages.append(div);
  messages.scrollTop = messages.scrollHeight;
};

const addApproval = (call, approvalId) => {
  const div = document.createElement("div");
  div.className = "approval";
  div.innerHTML = `
    <div class="name"></div>
    <div class="args"></div>
    <div class="actions">
      <button data-approve>Approve</button>
      <button data-reject>Reject</button>
    </div>`;
  div.querySelector(".name").textContent = call.function.name;
  div.querySelector(".args").textContent = call.function.arguments;

  const decide = async (approved) => {
    div.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await fetch(`/approve/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = approved ? "approved" : "rejected";
    div.append(status);
  };

  div.querySelector("[data-approve]").addEventListener("click", () => decide(true));
  div.querySelector("[data-reject]").addEventListener("click", () => decide(false));
  messages.append(div);
  messages.scrollTop = messages.scrollHeight;
};

const readStream = async (response, onEvent) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        // skip partial frames
      }
    }
  }
};

const send = async () => {
  const message = input.value.trim();
  if (!message) return;

  addMessage("user", message);
  input.value = "";
  sendBtn.disabled = true;

  const assistant = addMessage("assistant", "");

  try {
    const response = await fetch(`/chat/${threadId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    await readStream(response, (data) => {
      switch (data.type) {
        case "content":
          assistant.textContent += data.content;
          break;
        case "tool_approval_required":
          addApproval(data.call, data.approvalId);
          break;
        case "tool_executing":
          addTool(`executing ${data.name}`);
          break;
        case "tool_complete":
          addTool(`${data.name} -> ${JSON.stringify(data.result)}`);
          break;
        case "tool_error":
          addTool(`${data.name} failed: ${data.error}`);
          break;
        case "error":
          assistant.textContent = `Error: ${data.message}`;
          break;
      }
    });
  } catch (error) {
    assistant.textContent = `Network error: ${error.message}`;
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
};

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});
input.focus();
