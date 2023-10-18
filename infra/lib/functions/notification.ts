import axios from 'axios';
import { SNSEvent } from 'aws-lambda';

const HookUrl = process.env.HOOK_URL!;

export const handler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    const message = record.Sns.Message;
    console.log(message);

    if (HookUrl.length > 0) {
      const resp = await axios.post(
        HookUrl,
        {
          Content: record.Sns.Message,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      console.log(resp);
    }
  }

  return 'ok';
};
