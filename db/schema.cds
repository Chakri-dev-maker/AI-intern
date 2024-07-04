namespace com.qil.rag.ai;

using {
    cuid,
    managed
} from '@sap/cds/common';

@assert.range
type botTypeEnum        : String(50) enum {
    MS_OPENAI;
    GOOGLE_VERTEXAI
};

@assert.range
type documentStatusEnum : String(100) enum {
    UPLOADED;
    PROCESSING;
    PROCESSED;
    FAILED
};

@assert.range
type settingsNameEnum   : String(100) enum {
    DOCUMENTS_TOPK;
    CHUNK_SIZE;
    CHUNK_OVERLAP_SIZE;
    COMPARISON_ALGORITHM;
    EMBEDDING_MODEL_CONFIG_ID;
    COHERE_API_KEY;
    DOCUMENT_SUMMARIZATION_ENABLED;
    DOCUMENT_SUMMARIZATION_CHUNK_SIZE;
    DOCUMENT_SUMMARIZATION_CONFIG_ID;
    DOCUMENT_SPLITTER;
};

entity Bots : cuid, managed {
    botName          : String(100) not null;
    botDescription   : String(500) not null;
    initialPrompt    : String(5000) not null;
    documentLevelPreprocEnabled : Boolean default false not null;
    cohereRerankingEnabled      : Boolean default false not null;
    hydeEnabled                 : Boolean default false not null;   
    botConfigName    : String(100);
    botConfiguration : Association to BotConfigurations not null @assert.integrity;
    Documents        : Composition of many DocumentBotRelationships on Documents.botID = $self;
    Conversations    : Composition of many Conversation on Conversations.botID = $self;
}

entity BotConfigurations : cuid, managed {
    botConfigName        : String(50) not null;
    botConfigDescription : String(100) not null;
    botConfigType        : botTypeEnum not null;
    isEmbeddingConfig    : Boolean default false not null;
    botDestinationName   : String(100) not null;
    botResourceGroup     : String(50) not null;
    botApiVersion        : String(50) not null;
}

entity Documents : cuid, managed {
    documentName             : String(500) not null;
    documentDescription      : String(500) not null;
    documentSummary          : LargeString;

    @Core.IsMediaType                : true
    documentType             : String(100);

    documentStatus           : documentStatusEnum;
    documentNotes            : String(500);
    documentNoOfChunks       : Integer;
    documentChunkSize        : Integer;
    documentChunkOverlapSize : Integer;
    documentVector           : Vector;

    @Core.MediaType                  : documentType
    @Core.ContentDisposition.Filename: documentName
    documentContent          : LargeBinary;
    Bots                     : Composition of many DocumentBotRelationships on Bots.documentID = $self;
}

entity Embeddings : cuid, managed {
    documentID      : UUID not null;
    embeddingText   : LargeString;
    embeddingVector : Vector;
}

@assert.unique: {DocumentBotMappings: [
    botID,
    documentID
]}
entity DocumentBotRelationships : cuid, managed {
    @cascade: {delete}
    botID        : Association to Bots not null @assert.integrity;
    botName      : String(100);

    @cascade: {delete}
    documentID   : Association to Documents not null @assert.integrity;
    documentName : String(500);
}

entity Conversation : cuid {
    userID         : String(50) not null;

    @cascade: {delete}
    botID          : Association to Bots not null @assert.integrity;

    title          : String(100) not null;
    sentMessages   : Composition of many Message
                         on sentMessages.conversationID = $self;

    creationTime   : Timestamp not null;
    lastUpdateTime : Timestamp;
}

entity Message {
        @cascade: {delete}
    key conversationID : Association to Conversation not null @assert.integrity;

    key messageID      : UUID not null;
        role           : String not null;
        content        : LargeString not null;
        creationTime   : Timestamp not null;
}

@assert.unique: {settingName: [settingName]}
entity Settings : cuid, managed {
    settingName  : settingsNameEnum not null;
    settingValue : String(50) not null;
}