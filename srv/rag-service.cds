using {com.qil.rag.ai as db} from '../db/schema';

service RagService @(requires: 'authenticated-user') {
    entity Bots                     as projection on db.Bots;

    entity Documents @(restrict: [
        {
            grant: [
                'READ',
                'WRITE',
                'UPDATE',
                'DELETE'
            ],
            to   : 'QILRAGAdmin'
        },
        {
            grant: [
                'READ',
                'WRITE',
                'UPDATE',
                'DELETE'
            ],
            where: 'createdBy = $user'
        }
    ])                              as
        projection on db.Documents
        excluding {
            documentVector
        };

    entity BotConfigurations @(restrict: [
        {grant: 'READ'},
        {
            grant: [
                'READ',
                'WRITE',
                'UPDATE',
                'DELETE'
            ],
            to   : 'QILRAGAdmin'
        }
    ])                              as projection on db.BotConfigurations;

    entity Conversation @(restrict: [
        {
            grant: [
                'READ',
                'WRITE',
                'UPDATE',
                'DELETE'
            ],
            to   : 'QILRAGAdmin'
        },
        {
            grant: [
                'READ',
                'WRITE',
                'DELETE'
            ],
            where: 'userID = $user'
        }
    ])                              as projection on db.Conversation;

    entity Message                  as projection on db.Message;

    entity Settings @(restrict: [
        {grant: 'READ'},
        {
            grant: [
                'READ',
                'WRITE',
                'UPDATE',
                'DELETE'
            ],
            to   : 'QILRAGAdmin'
        }
    ])                              as projection on db.Settings;

    entity Embeddings               as
        projection on db.Embeddings
        excluding {
            embeddingVector
        };

    entity DocumentBotRelationships as projection on db.DocumentBotRelationships;

    type RagResponseAdditionalContents {
        score        : String;
        pageContent  : String;
        documentName : String;
        documentID   : String;
        rerankScore  : String;
        docScore     : String;
    }

    type RagResponse {
        role               : String;
        content            : String;
        messageTime        : String;
        isRagResponse      : Boolean;
        usedHyDE           : Boolean;
        conversationID     : String;
        conversationTitle  : String;
        additionalContents : array of RagResponseAdditionalContents;
    }

    action   createEmbeddings(documentID : String, regenerateSummaries : Boolean)            returns String;
    action   getChatRagResponse(botID : String, conversationID : String, userQuery : String, privateMode : Boolean) returns RagResponse;
    
    function deleteChatData(conversationID : String)                                         returns String;
    function regenerateSummaries(documentID : String)                                        returns String;
    function regenerateMissingSummaries()                                                    returns String;
    function deleteEmbeddings(documentID : String)                                           returns String;
}
