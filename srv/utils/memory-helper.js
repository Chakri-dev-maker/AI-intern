const cds = require("@sap/cds");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const { INSERT, SELECT, UPDATE } = cds.ql;
const { v4: uuidv4 } = require("uuid");

// Helper method to get the current timestamp
function getCurrentTimestamp() {
  return new Date().toISOString();
}

// Helper method to insert the messages and update the latest conversation timestamp in db
async function insertMessage(
  messageEntity,
  messageRecord,
  conversationID,
  conversationEntity,
  messageTime
) {
  console.log(`Inserting new message for conversation id: ${conversationID}`);
  const messageInsertionStatus = await INSERT.into(messageEntity).entries([
    messageRecord,
  ]);
  if (!messageInsertionStatus) {
    throw new Error("Insertion of message into db failed!");
  }

  console.log(`Updating the time for conversation id: ${conversationID}`);
  const updateConversationStatus = await UPDATE(conversationEntity)
    .set`lastUpdateTime = ${messageTime}`.where`ID = ${conversationID}`;
  if (updateConversationStatus !== 1) {
    throw new Error("Updating the conversation time failed!");
  }
}

// Helper method to handle conversation memory in HANA CLoud before RAG LLM call.
async function handleMemoryBeforeRagCall(
  conversationID,
  botDetails,
  messageTime,
  userID,
  userQuery,
  Conversation,
  Message,
  botConfig
) {
  try {
    var conversationTitle;
    const botID = botDetails[0].ID;
    const botType = botConfig[0].botConfigType;
    const memoryContext = [];
    const CONVERSATION_HISTORY_LIMIT = 30;
    // Check if conversation exists in the db
    const isConversationPresent = await SELECT.from(Conversation)
      .columns("ID", "title")
      .where({ ID: conversationID, botID_ID: botID });

    if (isConversationPresent.length > 0) {
      console.log(`Retrieving messages for conversation id: ${conversationID}`);

      var messageSelectStmt = await SELECT.from(Message)
        .where({ conversationID_ID: conversationID })
        .orderBy("creationTime desc")
        .limit(CONVERSATION_HISTORY_LIMIT);

      messageSelectStmt.sort(
        (a, b) => new Date(a.creationTime) - new Date(b.creationTime)
      );

      if (messageSelectStmt.length > 0) {
        messageSelectStmt.forEach((message) => {
          switch (botType) {
            case "GOOGLE_VERTEXAI":
              memoryContext.push({
                role: message.role,
                parts: { text: message.content },
              });
              break;
            case "MS_OPENAI":
              memoryContext.push({
                role: message.role,
                content: message.content,
              });
              break;
          }
        });
      } else {
        throw new Error(
          `Messages corresponding to conversation id: ${conversationID} not present!`
        );
      }
    }
    // If conversation is not present, insert the conversation into db
    else {
      const isConversationForCurrentBot = await SELECT.from(Conversation)
        .columns("ID", "title")
        .where({ ID: conversationID });

      if (isConversationForCurrentBot.length > 0) {
        throw new Error(
          `Conversation id: ${conversationID} already exists for another bot!`
        );
      }
      conversationTitle = await getConversationSummarization(
        userQuery,
        botDetails
      );

      conversationTitle = conversationTitle.replace(/^"|"$/g, "");

      console.log(
        `Inserting new conversation for conversation id: ${conversationID}`
      );
      const currentTimestamp = getCurrentTimestamp();
      const conversationEntry = {
        ID: conversationID,
        userID: userID,
        botID_ID: botID,
        creationTime: currentTimestamp,
        title: conversationTitle,
      };
      const conversationInsertStatus = await INSERT.into(Conversation).entries([
        conversationEntry,
      ]);
      if (!conversationInsertStatus) {
        throw new Error("Insertion of conversation into db failed!");
      }
      if (!conversationID)
        conversationID = Array.from(
          conversationInsertStatus.results.values()
        )[0].values[0];
    }

    // In both cases, insert the message into db
    const messageID = cds.utils.uuid();
    const messageRecord = {
      conversationID_ID: conversationID,
      messageID: messageID,
      role: "user",
      content: userQuery,
      creationTime: messageTime,
    };

    await insertMessage(
      Message,
      messageRecord,
      conversationID,
      Conversation,
      messageTime
    );

    const convoTitle = isConversationPresent[0]?.title
      ? isConversationPresent[0]?.title
      : conversationTitle;
    return { memoryContext, conversationID, conversationTitle: convoTitle };
  } catch (error) {
    // Handle any errors that occur during the execution
    console.log("Error handling memory prior to RAG response:", error);
    throw error;
  }
}

// Helper method to handle conversation memory in HANA CLoud after RAG LLM call.
async function handleMemoryAfterRagCall(
  conversationID,
  messageTime,
  chatRagResponse,
  Message,
  Conversation
) {
  try {
    const aiMessageRecord = {
      conversationID_ID: conversationID,
      messageID: uuidv4(),
      role: chatRagResponse.role,
      content: chatRagResponse.content,
      creationTime: messageTime,
    };

    // Insert the assistant message to db
    await insertMessage(
      Message,
      aiMessageRecord,
      conversationID,
      Conversation,
      getCurrentTimestamp()
    );
  } catch (error) {
    // Handle any errors that occur during the execution
    console.log("Error handling memory post RAG response:", error);
    throw error;
  }
}

async function getConversationSummarization(userQuestion, botDetails) {
  const prompt =
    "Write a short generic summary, less than 50 characters, on the user input enclosed in three backticks, even if the user input is a question. \n \
  Keep in mind that the summary represents the title of the conversation. Do not try to answer the question. Do not include the word 'Summary' in any form in the returned text. \n \
  The summary generated should be different from the user input. Only return the summary and nothing else ! \n\n ```" +
    userQuestion +
    "```";
  return await getLLMResponse(prompt, botDetails[0].botConfiguration_ID);
}

async function getHyDEResponse(userQuestion, botDetails) {
  const prompt = `Please write a passage to answer the question as if you have all the required information to answer the question. \n
  Use a natural communication style with lists and bullet points and explanations when required. \nBe succinct and prefer generating shorter responses.\n
  If the question is not a question return the text "NAQ" and nothing else.\n  Question: ${userQuestion}\nPassage:`;
  return await getLLMResponse(prompt, botDetails[0].botConfiguration_ID);
}

async function summarizeText(text, docSummarizationConfigID) {
  const prompt =
    "Generate a detailed summarization, less than 500 characters, on the user input enclosed in three backticks. \
    Always extract important entities from the document such as names and other relevant entities. \
    Use multiple shorter paragraphs. Use lists only if necessary and prefer multi level lists over long lists. \
    Ignore disclainers, copyright or other notices and do not include these in the output. \
    The summary should be in markdown formatted text only. \
    Only return the summary and nothing else. Do not include the word 'Summary' as a header in the returned text.\n\n ```" +
    text +
    "```";
  return await getLLMResponse(prompt, docSummarizationConfigID);
}

async function getLLMResponse(prompt, botConfigurationID) {
  const { BotConfigurations } = cds.entities;

  const botConfig = await SELECT.from(BotConfigurations)
    .columns(
      "botApiVersion",
      "botDestinationName",
      "botResourceGroup",
      "botConfigType"
    )
    .where({ ID: botConfigurationID });

  if (!botConfig) {
    throw new Error("Failed to get Bot configuration !");
  }

  const botType = botConfig[0].botConfigType;
  const apiVersion = botConfig[0].botApiVersion;
  const genAIDestName = botConfig[0].botDestinationName;
  const resourceGroupname = botConfig[0].botResourceGroup;

  const reqHeaders = {
    "Content-Type": "application/json",
    "AI-Resource-Group": resourceGroupname,
  };

  var urlString = "";
  var reqPayload;

  switch (botType) {
    case "GOOGLE_VERTEXAI":
      urlString = `/models/gemini-1.0-pro:generateContent`;
      reqPayload = {
        contents: [
          {
            role: "user",
            parts: {
              text: prompt,
            },
          },
        ],
        generation_config: {
          temperature: 0.3,
        },
      };
      break;
    case "MS_OPENAI":
      urlString = `/chat/completions?api-version=${apiVersion}`;
      reqPayload = {
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
      };
      break;
  }
  try {
    var response = await executeHttpRequest(
      {
        destinationName: genAIDestName,
      },
      {
        method: "POST",
        url: urlString,
        headers: reqHeaders,
        data: reqPayload,
      },
      {
        fetchCsrfToken: false,
      }
    );
  } catch (error) {
    const errMsg = error.message ? error.message : error;
    throw new Error(`Failed to get LLM response : ${errMsg}`);
  }

  response = response?.data;

  switch (botType) {
    case "GOOGLE_VERTEXAI":
      if (response.candidates && response.candidates.length > 0) {
        if (response.candidates[0]?.finishReason) {
          switch (response.candidates[0]?.finishReason) {
            case "STOP":
            case "MAX_TOKENS":
              break;
            case "SAFETY":
              throw new Error(
                "Gemini's response was blocked by its content filters for safety reasons ! Please change your content and try again ?"
              );
            case "RECITATION":
              throw new Error(
                "Gemini's response was blocked by its content filters for recitation reasons ! Please change your content and try again ?"
              );
            case "OTHER":
            default:
              throw new Error(
                "Gemini's response was blocked by its content filters ! Please try again ?"
              );
          }
        }
        if (!response.candidates[0]?.content?.parts[0]?.text)
          throw new Error(
            "Empty response or invalid response data received from Gemini ! Please try again ?"
          );
        else return response?.candidates[0]?.content?.parts[0]?.text;
      } else {
        if (response.promptFeedback?.blockReason) {
          throw new Error(
            `Gemini's response was blocked by its content filters due to '${response.promptFeedback?.blockReason}' ! Please try again ? `
          );
        } else {
          throw new Error(
            "Empty response or invalid response data received from Gemini ! Please try again ?"
          );
        }
      }
      break;
    case "MS_OPENAI":
      if (!response.choices[0]?.message?.content)
        throw new Error(
          "Empty response or invalid response data received from ChatGPT ! Please try again ?"
        );
      else return response?.choices[0]?.message?.content;
      break;
  }
}

module.exports = {
  handleMemoryBeforeRagCall,
  handleMemoryAfterRagCall,
  getHyDEResponse,
  summarizeText,
};
