import { MessageType } from "../api-zalo/models/Message.js";
import { getDataAllGroup } from "../service-debug/info-service/group-info.js";
import { readWebConfig, writeWebConfig } from "../utils/io-json.js";
import { addPendingTask, removePendingTask, loadPendingTasks } from "../skills/task-persistence.js";

let bulkMessageInterval = null;

export async function sendBulkMessage(api, socket, data) {
  const { content, interval, filePaths } = data;
  console.log("Nhận yêu cầu startBulkMessage:", content, interval);
  const bulkMessageContent = content;
  const bulkImageUrls = filePaths;
  if (bulkMessageInterval) {
    clearInterval(bulkMessageInterval);
  }

  addPendingTask({
    id: `bulk_message_${Date.now()}`,
    type: "bulk_message",
    status: "pending",
    data: {
      content: bulkMessageContent,
      interval,
      filePaths: bulkImageUrls
    }
  });

  const sendMessages = async () => {
    const webConfig = readWebConfig();
    const selectedFriends = webConfig.selectedFriends;
    const selectedGroups = webConfig.selectedGroups;

    for (const friendId in selectedFriends) {
      if (selectedFriends[friendId]) {
        try {
          await api.sendMessage(
            {
              msg: bulkMessageContent,
              attachments: bulkImageUrls,
              ttl: interval,
            },
            friendId,
            MessageType.DirectMessage
          );
        } catch (error) {
        }
      }
    }

    for (const groupId in selectedGroups) {
      if (selectedGroups[groupId]) {
        try {
          await api.sendMessage(
            {
              msg: bulkMessageContent,
              attachments: bulkImageUrls,
              ttl: interval,
            },
            groupId,
            MessageType.GroupMessage
          );
        } catch (error) {
        }
      }
    }
  };

  await sendMessages();

  bulkMessageInterval = setInterval(sendMessages, interval);

  console.log("Đã bắt đầu gửi tin nhắn hàng loạt");
  socket.emit("bulkMessageStatus", "started");
}

export async function stopBulkMessage() {
  if (bulkMessageInterval) {
    clearInterval(bulkMessageInterval);
    bulkMessageInterval = null;
  }
  const tasks = loadPendingTasks().filter(t => t.type === "bulk_message");
  for (const task of tasks) {
    removePendingTask(task.id);
  }
}

export async function resumeBulkMessages(api, io) {
  const tasks = loadPendingTasks().filter(t => t.type === "bulk_message" && t.status === "pending");
  for (const task of tasks) {
    if (!task.data) continue;
    const { content, interval, filePaths } = task.data;
    if (bulkMessageInterval) {
      clearInterval(bulkMessageInterval);
    }
    const sendMessages = async () => {
      const webConfig = readWebConfig();
      const selectedFriends = webConfig.selectedFriends;
      const selectedGroups = webConfig.selectedGroups;

      for (const friendId in selectedFriends) {
        if (selectedFriends[friendId]) {
          try {
            await api.sendMessage(
              {
                msg: content,
                attachments: filePaths,
                ttl: interval,
              },
              friendId,
              MessageType.DirectMessage
            );
          } catch (error) {
            console.error("Loi gui tin nhan ban be:", error.message);
          }
        }
      }

      for (const groupId in selectedGroups) {
        if (selectedGroups[groupId]) {
          try {
            await api.sendMessage(
              {
                msg: content,
                attachments: filePaths,
                ttl: interval,
              },
              groupId,
              MessageType.GroupMessage
            );
          } catch (error) {
            console.error("Loi gui tin nhan nhom:", error.message);
          }
        }
      }
    };

    await sendMessages();
    bulkMessageInterval = setInterval(sendMessages, interval);
    console.log(`[AutoSessionSwitch] Da resume bulk message cho task ${task.id}`);
  }
}
