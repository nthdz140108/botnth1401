import React, { useEffect, useState } from "react";
import { ChatPolicyPanel } from "./chat-policy-panel.jsx";

export function ChatAccessWorkspace({ bots }) {
  const [selectedBot, setSelectedBot] = useState(() => bots.find((bot) => bot.id !== "admin")?.id || bots[0]?.id || "");

  useEffect(() => {
    if (!bots.some((bot) => bot.id === selectedBot)) setSelectedBot(bots.find((bot) => bot.id !== "admin")?.id || bots[0]?.id || "");
  }, [bots, selectedBot]);

  return (
    <section className="panel workspace">
      <div className="section-heading">
        <div>
          <p className="kicker">CHAT ACCESS</p>
          <h2>Chat access</h2>
          <p className="muted">Choose a bot and control group and private chat independently.</p>
        </div>
      </div>
      <div className="toolbar chat-policy-selector">
        <label htmlFor="chat-access-bot">Bot</label>
        <select id="chat-access-bot" value={selectedBot} onChange={(event) => setSelectedBot(event.target.value)}>
          <option value="">Select bot</option>
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName || bot.id}</option>)}
        </select>
      </div>
      {selectedBot ? <ChatPolicyPanel botId={selectedBot} /> : <p className="muted">No bot is available.</p>}
    </section>
  );
}
