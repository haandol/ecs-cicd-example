import * as got from 'got';
import { SNSEvent } from 'aws-lambda';

const HookUrl = process.env.HOOK_URL!;

export const handler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    if (HookUrl.length > 0) {
      const resp = await got.post(HookUrl, {
        json: message,
      });
      console.log(resp);
    }
    console.log(message);
  }

  return 'ok';
};
