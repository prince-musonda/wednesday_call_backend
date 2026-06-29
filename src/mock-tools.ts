const DefaultToolSchema = JSON.stringify({
    "type": "object",
    "properties": {},
    "required": []
});

// GET DATE
const getDateToolSpec = {
    toolSpec: {
        name: "getDateTool",
        description: "Get information about the current date",
        inputSchema: { json: DefaultToolSchema }
    }
}
function getDate() {
    const date = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const pstDate = new Date(date);
    return {
        date: pstDate.toISOString().split('T')[0],
        year: pstDate.getFullYear(),
        month: pstDate.getMonth() + 1,
        day: pstDate.getDate(),
        dayOfWeek: pstDate.toLocaleString('en-US', { weekday: 'long' }).toUpperCase(),
        timezone: "PST"
    };
}

// GET TIME
const getTimeToolSpec = {
    toolSpec: {
        name: "getTimeTool",
        description: "Get information about the current time",
        inputSchema: { json: DefaultToolSchema }
    }
}
function getTime() {
    const pstTime = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    return {
        timezone: "PST",
        formattedTime: new Date(pstTime).toLocaleTimeString('en-US', {
            hour12: true,
            hour: '2-digit',
            minute: '2-digit'
        })
    };
}

// QUERY KNOWLEDGE BASE - retrieve relevant information from the org's vector database
const queryKnowledgeBaseSchema = JSON.stringify({
    "type": "object",
    "properties": {
        "orgId": {
            "type": "string",
            "description": "The unique identifier of the organisation whose knowledge base to query"
        },
        "query": {
            "type": "string",
            "description": "The question or topic to look up in the knowledge base"
        }
    },
    "required": ["orgId", "query"]
});

async function queryKnowledgeBase({ orgId, query }: { orgId: string; query: string }) {
    const endpoint = process.env.RAG_ENDPOINT;
    if (!endpoint) {
        console.warn('RAG_ENDPOINT env var not set');
        return { result: 'Knowledge base is not available at the moment.' };
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ org_id: orgId, query }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await response.json() as { result?: string };
        return { result: data.result || 'No relevant information found.' };
    } catch (error: any) {
        const reason = error?.name === 'AbortError' ? 'timeout' : error;
        console.error('Knowledge base query failed:', reason);
        return { result: 'I could not retrieve that information right now. Please try again in a moment.' };
    }
}

const queryKnowledgeBaseToolSpec = {
    toolSpec: {
        name: "queryKnowledgeBase",
        description: "Search the organisation's knowledge base to answer a caller's question. Use this whenever you need information about the organisation.",
        inputSchema: { json: queryKnowledgeBaseSchema }
    }
}

// SAVE SUMMARY - post a conversation summary to the configured endpoint at end of call
const saveSummarySchema = JSON.stringify({
    "type": "object",
    "properties": {
        "orgId": {
            "type": "string",
            "description": "The unique identifier of the organisation this call was for"
        },
        "summary": {
            "type": "string",
            "description": "A detailed summary of the entire conversation including topics discussed, questions asked, and any information provided"
        }
    },
    "required": ["orgId", "summary"]
});

async function saveSummary({ orgId, summary }: { orgId: string; summary: string }) {
    const endpoint = process.env.SUMMARY_ENDPOINT;
    if (!endpoint) {
        console.warn('SUMMARY_ENDPOINT env var not set — summary not saved');
        return { success: false, reason: 'SUMMARY_ENDPOINT not configured' };
    }
    const apiKey = process.env.SERVICE_API_KEY;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ org_id: orgId, content: summary, type: 'call' })
        });
        console.log(`Summary saved for org ${orgId}, status: ${response.status}`);
        return { success: response.ok };
    } catch (error) {
        console.error('Failed to save summary:', error);
        return { success: false };
    }
}

const saveSummaryToolSpec = {
    toolSpec: {
        name: "saveSummary",
        description: "Save a detailed summary of the conversation at the end of the call. Always invoke this tool before the call ends.",
        inputSchema: { json: saveSummarySchema }
    }
}

const availableTools = [
    getDateToolSpec,
    getTimeToolSpec,
    queryKnowledgeBaseToolSpec,
    saveSummaryToolSpec,
]

const toolHandlers: Record<string, Function> = {
    "getdatetool": getDate,
    "gettimetool": getTime,
    "queryknowledgebase": queryKnowledgeBase,
    "savesummary": saveSummary,
}

async function toolProcessor(toolName: string, toolArgs: string): Promise<object> {
    const args = JSON.parse(toolArgs);
    console.log(`Tool ${toolName} invoked with args`, args);

    if (toolName in toolHandlers) {
        const tool = toolHandlers[toolName];
        if (tool.constructor.name === "AsyncFunction") {
            return await tool(args);
        } else {
            return tool(args);
        }
    } else {
        console.log(`Tool ${toolName} not supported`);
        return { message: "I cannot help you with that request", success: false };
    }
}

export { availableTools, toolProcessor }
