{{user}} gave you feedback on {{what}} in #{{channel}}. This job is about your rules, not the channel's work: don't redo or continue the original work.

<feedback>
{{feedback}}
</feedback>

<message time="{{time}}">
{{message}}
</message>
{{job}}
The conversation that led to it, oldest first (the whole channel is in {{messagesFile}}):
<history>
{{history}}
</history>

Your rules:
- Your instructions: {{agentFile}}, the text after the front matter. It's the only file you change.
- Your memories: {{memoryDir}}. Read them: one may hold a rule that caused this. Change a memory only if it's wrong.
- The team rules every teammate gets, which you can't change. In the chat, `{{instructions}}` is where your instructions go:
<chat-rules>
{{chatRules}}
</chat-rules>
<job-rules>
{{jobRules}}
</job-rules>

What to do:
1. From the history, work out what you were asked, what you did, and how it missed what {{user}} wanted.
2. Find the lines in your rules, or the gap in them, that led to that result.
3. Amend your instructions so the feedback becomes part of them:
   - Fold it into the rule it belongs to, as the rule behind this case, not a note about this channel or message.
   - Keep every behavior your rules intend. Where the feedback contradicts a rule, the feedback wins.
   - Keep the file as short as possible: merge and tighten what you touch, and drop repetition, but drop nothing still intended.
   - If the cause is in the team rules, add the narrowest override to your instructions and say so in the report.
4. Report in a few lines: the feedback, the cause, and each changed rule as before → after.
