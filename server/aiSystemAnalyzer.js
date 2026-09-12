import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const client = new Anthropic();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readProjectFiles() {
  const files = {};
  try {
    files.writeOps = fs.readFileSync('./server/writeOps.js', 'utf-8').slice(0, 4000);
  } catch (e) {
    files.writeOps = 'writeOps.js not found';
  }
  try {
    files.httpApi = fs.readFileSync('./server/httpApi.js', 'utf-8').slice(0, 3000);
  } catch (e) {
    files.httpApi = 'httpApi.js not found';
  }
  try {
    files.auth = fs.readFileSync('./server/auth.js', 'utf-8').slice(0, 2000);
  } catch (e) {
    files.auth = 'auth.js not found';
  }
  try {
    files.bootstrap = fs.readFileSync('./server/bootstrap.js', 'utf-8').slice(0, 2000);
  } catch (e) {
    files.bootstrap = 'bootstrap.js not found';
  }
  return files;
}

export async function analyzeWholeSystem() {
  try {
    const files = readProjectFiles();

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are a senior software architect. Analyze this entire application system and provide insights:

**Core Operations (writeOps.js):**
\`\`\`javascript
${files.writeOps}
\`\`\`

**HTTP API Layer (httpApi.js):**
\`\`\`javascript
${files.httpApi}
\`\`\`

**Authentication (auth.js):**
\`\`\`javascript
${files.auth}
\`\`\`

**Bootstrap/Data Model (bootstrap.js):**
\`\`\`javascript
${files.bootstrap}
\`\`\`

Please provide a comprehensive analysis with:
1. **Architecture Overview** - How do these components interact?
2. **Current Issues** - What bugs or design problems do you see?
3. **Performance Bottlenecks** - Where could it be optimized?
4. **Security Concerns** - Any security vulnerabilities?
5. **Top 5 Improvements** - Prioritized recommendations
6. **Best Practices Missing** - What's not following industry standards?`
      }]
    });

    return response.content[0].text;
  } catch (error) {
    console.error('System analysis error:', error);
    throw error;
  }
}

export async function getArchitectureRecommendations() {
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `For a Node.js/React business application with these features:
- Quotation & sales management
- Cutting list creation & production tracking
- Sales receipts & payments
- Accounting & ledger
- Inventory & material management
- User authentication & role-based permissions
- Audit logging

Recommend improvements for:
1. Database schema design
2. Caching strategy (Redis, in-memory)
3. API optimization & pagination
4. Frontend state management
5. Error handling & logging
6. Testing strategy (unit, integration, e2e)
7. Deployment & DevOps
8. Monitoring & observability`
    }]
  });

  return response.content[0].text;
}

export async function debugIssue(description, relatedCode) {
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Debug this application issue:\n\nProblem: ${description}\n\nRelevant Code:\n\`\`\`\n${relatedCode}\n\`\`\`\n\nProvide:
1. Root cause analysis
2. Why it's happening
3. Step-by-step fix
4. Prevention strategy
5. Tests to prevent regression`
    }]
  });

  return response.content[0].text;
}

export async function suggestFeatureImplementation(featureDescription) {
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `How should I implement this feature in my Node.js/React/SQLite app?\n\nFeature: ${featureDescription}\n\nProvide:
1. Database schema changes
2. Backend API endpoints (routes, parameters)
3. Frontend React components
4. State management approach
5. Error handling
6. Testing strategy
7. Security considerations
8. Estimated effort (hours)`
    }]
  });

  return response.content[0].text;
}

export async function analyzeCode(code, context) {
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Analyze this code in context of: ${context}\n\n\`\`\`\n${code}\n\`\`\`\n\nProvide:
1. What it does
2. Bugs or issues
3. Performance improvements
4. Best practices
5. Security concerns`
    }]
  });

  return response.content[0].text;
}

export async function performanceAnalysis() {
  const files = readProjectFiles();
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `Analyze the performance of this system:\n\n${files.writeOps}\n\nIdentify:
1. N+1 query problems
2. Inefficient loops or algorithms
3. Missing indexes
4. Caching opportunities
5. Database query optimization
6. Frontend rendering issues
7. Memory leaks
8. Detailed fixes for each issue`
    }]
  });

  return response.content[0].text;
}
