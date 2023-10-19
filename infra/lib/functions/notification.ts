import axios from 'axios';
import { SNSEvent } from 'aws-lambda';

const HookUrl = process.env.HOOK_URL!;

export const handler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    const message = record.Sns.Message;
    console.log(message);

    if (HookUrl.length > 0) {
      try {
        const resp = await axios.post(
          HookUrl,
          {
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `Deploy: \`\`\`${message}\`\`\``,
                },
              },
            ],
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
        console.log('resp: ', resp);
      } catch (e) {
        console.error('failed to invoke hook: ', e);
      }
    }
  }

  return 'ok';
};
