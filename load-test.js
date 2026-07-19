import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
};

export default function () {
  const baseUrl = __ENV.BASE_URL;

  if (!baseUrl) {
    throw new Error('BASE_URL is missing');
  }

  const response = http.get(baseUrl);

  check(response, {
    'status is 200': (res) => res.status === 200,
    'response time is below 2 seconds': (res) =>
      res.timings.duration < 2000,
  });

  sleep(1);
}
