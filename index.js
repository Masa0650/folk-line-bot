require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const sessions = new Map();
const ADMIN_PASSWORD = 'oppai315';

app.get('/', (req, res) => {
  res.send('LINE bot server is running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).end();
  }
});

async function getRegisteredName(userId) {
  const response = await axios.post(process.env.GAS_WEB_APP_URL, {
    action: 'get_name',
    lineUserId: userId,
  });
  return response.data;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userText = event.message.text.trim();
  const userId = event.source.userId;
  const session = sessions.get(userId);

  let replyText = '';

  if (userText === 'キャンセル') {
    if (sessions.has(userId)) {
      sessions.delete(userId);
      replyText = '現在の操作をキャンセルしました。';
    } else {
      replyText = 'キャンセルする操作はありません。';
    }

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: replyText,
        },
      ],
    });
    return;
  }

  if (userText === '名前登録' || userText === '名前変更') {
    sessions.set(userId, {
      step: 'waiting_name',
    });
    replyText = '予約で使う名前を送ってください。';

  } else if (userText === '名前確認') {
    try {
      const result = await getRegisteredName(userId);

      if (!result.ok) {
        replyText = '名前確認に失敗しました。\n' + (result.message || '不明なエラーです。');
      } else if (!result.registered) {
        replyText = 'まだ名前は登録されていません。';
      } else {
        replyText = `現在の登録名は「${result.userName}」です。`;
      }
    } catch (error) {
      console.error('GAS get_name error:', error.response?.data || error.message);
      replyText = '名前確認中にエラーが発生しました。';
    }

  } else if (session && session.step === 'waiting_name') {
    const name = userText;
    sessions.delete(userId);

    try {
      const response = await axios.post(process.env.GAS_WEB_APP_URL, {
        action: 'save_name',
        lineUserId: userId,
        userName: name,
      });

      const result = response.data;

      if (result.ok) {
        replyText = `名前を登録しました。\n登録名: ${result.userName}`;
      } else {
        replyText = '名前登録に失敗しました。\n' + (result.message || '不明なエラーです。');
      }
    } catch (error) {
      console.error('GAS save_name error:', error.response?.data || error.message);
      replyText = '名前登録中にエラーが発生しました。';
    }

  } else if (userText === '予約') {
    try {
      const nameResult = await getRegisteredName(userId);

      if (!nameResult.ok) {
        replyText = '名前確認に失敗しました。先に「名前登録」を試してください。';
      } else if (!nameResult.registered) {
        replyText = '先に「名前登録」をしてください。';
      } else {
        sessions.set(userId, {
          step: 'waiting_date',
          reservationType: 'normal',
          userName: nameResult.userName,
        });
        replyText = `予約を開始します。\n登録名: ${nameResult.userName}\n利用日を YYYY-MM-DD 形式で送ってください。例: 2026-05-03`;
      }
    } catch (error) {
      console.error('GAS get_name before reserve error:', error.response?.data || error.message);
      replyText = '予約開始前の名前確認でエラーが発生しました。';
    }

  } else if (userText === '予約禁止期間') {
    sessions.set(userId, {
      step: 'waiting_admin_password_for_block_create',
    });
    replyText = '管理者パスワードを入力してください。';

  } else if (userText === '禁止期間取消') {
    sessions.set(userId, {
      step: 'waiting_admin_password_for_block_delete',
    });
    replyText = '管理者パスワードを入力してください。';

  } else if (userText === '予約状況') {
    sessions.set(userId, {
      step: 'waiting_status_date',
    });
    replyText = '確認したい日付を YYYY-MM-DD 形式で送ってください。例: 2026-05-03';

  } else if (session && session.step === 'waiting_admin_password_for_block_create') {
    if (userText === ADMIN_PASSWORD) {
      sessions.set(userId, {
        step: 'waiting_date',
        reservationType: 'block',
        userName: '予約禁止期間',
      });
      replyText = '認証しました。\n予約禁止期間の登録を開始します。\n利用日を YYYY-MM-DD 形式で送ってください。例: 2026-05-03';
    } else {
      sessions.delete(userId);
      replyText = 'パスワードが違います。';
    }

  } else if (session && session.step === 'waiting_admin_password_for_block_delete') {
    if (userText === ADMIN_PASSWORD) {
      try {
        const response = await axios.post(process.env.GAS_WEB_APP_URL, {
          action: 'list_blocks',
        });

        const result = response.data;

        if (!result.ok) {
          sessions.delete(userId);
          replyText = '予約禁止期間一覧の取得に失敗しました。\n' + (result.message || '不明なエラーです。');
        } else if (!result.reservations || result.reservations.length === 0) {
          sessions.delete(userId);
          replyText = '現在、予約禁止期間はありません。';
        } else {
          sessions.set(userId, {
            step: 'waiting_block_cancel_number',
            cancelList: result.reservations,
          });

          const lines = ['取消したい予約禁止期間の番号を送ってください。'];
          result.reservations.forEach((reservation, index) => {
            lines.push(`${index + 1}. ${reservation.date} ${reservation.startTime}-${reservation.endTime}`);
          });
          replyText = lines.join('\n');
        }
      } catch (error) {
        sessions.delete(userId);
        console.error('GAS list_blocks error:', error.response?.data || error.message);
        replyText = '予約禁止期間一覧の取得中にエラーが発生しました。';
      }
    } else {
      sessions.delete(userId);
      replyText = 'パスワードが違います。';
    }

  } else if (userText === '予約確認') {
    try {
      const response = await axios.post(process.env.GAS_WEB_APP_URL, {
        action: 'list',
        lineUserId: userId,
      });

      const result = response.data;

      if (!result.ok) {
        replyText = '予約確認に失敗しました。\n' + (result.message || '不明なエラーです。');
        if (result.error) {
          replyText += '\n' + result.error;
        }
      } else if (!result.reservations || result.reservations.length === 0) {
        replyText = '現在、あなたの予約はありません。';
      } else {
        const lines = ['あなたの予約一覧です。'];
        result.reservations.forEach((reservation, index) => {
          lines.push(`${index + 1}. ${reservation.date} ${reservation.startTime}-${reservation.endTime}`);
        });
        replyText = lines.join('\n');
      }
    } catch (error) {
      console.error('GAS list error:', error.response?.data || error.message);
      replyText = '予約確認中にエラーが発生しました。';
    }

  } else if (userText === '取消') {
    try {
      const response = await axios.post(process.env.GAS_WEB_APP_URL, {
        action: 'list',
        lineUserId: userId,
      });

      const result = response.data;

      if (!result.ok) {
        replyText = '取消対象の取得に失敗しました。\n' + (result.message || '不明なエラーです。');
      } else if (!result.reservations || result.reservations.length === 0) {
        replyText = '取消できる予約がありません。';
      } else {
        sessions.set(userId, {
          step: 'waiting_cancel_number',
          cancelList: result.reservations,
        });

        const lines = ['取消したい予約番号を送ってください。'];
        result.reservations.forEach((reservation, index) => {
          lines.push(`${index + 1}. ${reservation.date} ${reservation.startTime}-${reservation.endTime}`);
        });
        replyText = lines.join('\n');
      }
    } catch (error) {
      console.error('GAS cancel list error:', error.response?.data || error.message);
      replyText = '取消対象の取得中にエラーが発生しました。';
    }

  } else if (session && session.step === 'waiting_cancel_number') {
    const number = Number(userText);

    if (!Number.isInteger(number) || number < 1 || number > session.cancelList.length) {
      replyText = `正しい番号を送ってください。1〜${session.cancelList.length} の数字で入力してください。`;
    } else {
      const target = session.cancelList[number - 1];
      sessions.delete(userId);

      try {
        const response = await axios.post(process.env.GAS_WEB_APP_URL, {
          action: 'delete',
          lineUserId: userId,
          eventId: target.eventId,
        });

        const result = response.data;

        if (result.ok) {
          replyText =
            '予約を取り消しました。\n' +
            `利用日: ${result.deleted.date}\n` +
            `開始時間: ${result.deleted.startTime}\n` +
            `終了時間: ${result.deleted.endTime}`;
        } else {
          replyText = '予約取消に失敗しました。\n' + (result.message || '不明なエラーです。');
        }
      } catch (error) {
        console.error('GAS delete error:', error.response?.data || error.message);
        replyText = '予約取消中にエラーが発生しました。';
      }
    }

  } else if (session && session.step === 'waiting_block_cancel_number') {
    const number = Number(userText);

    if (!Number.isInteger(number) || number < 1 || number > session.cancelList.length) {
      replyText = `正しい番号を送ってください。1〜${session.cancelList.length} の数字で入力してください。`;
    } else {
      const target = session.cancelList[number - 1];
      sessions.delete(userId);

      try {
        const response = await axios.post(process.env.GAS_WEB_APP_URL, {
          action: 'delete',
          eventId: target.eventId,
          deleteBlock: true,
        });

        const result = response.data;

        if (result.ok) {
          replyText =
            '予約禁止期間を取り消しました。\n' +
            `利用日: ${result.deleted.date}\n` +
            `開始時間: ${result.deleted.startTime}\n` +
            `終了時間: ${result.deleted.endTime}`;
        } else {
          replyText = '予約禁止期間の取消に失敗しました。\n' + (result.message || '不明なエラーです。');
        }
      } catch (error) {
        console.error('GAS delete block error:', error.response?.data || error.message);
        replyText = '予約禁止期間の取消中にエラーが発生しました。';
      }
    }

  } else if (session && session.step === 'waiting_status_date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(userText)) {
      sessions.delete(userId);

      try {
        const response = await axios.post(process.env.GAS_WEB_APP_URL, {
          action: 'list_by_date',
          date: userText,
        });

        const result = response.data;

        if (!result.ok) {
          replyText = '予約状況の取得に失敗しました。\n' + (result.message || '不明なエラーです。');
        } else if (!result.reservations || result.reservations.length === 0) {
          replyText = `${userText} には現在予約がありません。`;
        } else {
          const lines = [`${userText} の予約状況です。`];
          result.reservations.forEach((reservation, index) => {
            const label = reservation.type === 'block' ? '【禁止期間】' : '';
            lines.push(
              `${index + 1}. ${reservation.startTime}-${reservation.endTime} ${reservation.title}${label}`
            );
          });
          replyText = lines.join('\n');
        }
      } catch (error) {
        console.error('GAS list_by_date error:', error.response?.data || error.message);
        replyText = '予約状況の取得中にエラーが発生しました。';
      }
    } else {
      replyText = '日付の形式が違います。YYYY-MM-DD 形式で送ってください。例: 2026-05-03';
    }

  } else if (session && session.step === 'waiting_date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(userText)) {
      if (session.reservationType === 'normal') {
        const [year, month, day] = userText.split('-').map(Number);

        // JST基準で「利用日 00:00」を作る
        const targetDateJst = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

        // 7日前のJST 00:00
          const bookingOpenDateJst = new Date(targetDateJst);
        bookingOpenDateJst.setUTCDate(bookingOpenDateJst.getUTCDate() - 7);

        // 現在時刻をJSTに補正して比較
        const now = new Date();
        const nowJst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

        const bookingOpenMillis = Date.UTC(
          bookingOpenDateJst.getUTCFullYear(),
          bookingOpenDateJst.getUTCMonth(),
          bookingOpenDateJst.getUTCDate(),
          0, 0, 0
        );

        const nowJstMillis = Date.UTC(
          nowJst.getUTCFullYear(),
          nowJst.getUTCMonth(),
          nowJst.getUTCDate(),
          nowJst.getUTCHours(),
          nowJst.getUTCMinutes(),
          nowJst.getUTCSeconds()
        );

        if (nowJstMillis < bookingOpenMillis) {
          const y = bookingOpenDateJst.getUTCFullYear();
          const m = String(bookingOpenDateJst.getUTCMonth() + 1).padStart(2, '0');
          const d = String(bookingOpenDateJst.getUTCDate()).padStart(2, '0');

          replyText = `予約可能期間外です。${y}-${m}-${d} 00:00 から予約できます。`;
        } else {
          sessions.set(userId, {
            ...session,
            step: 'waiting_start_time',
            date: userText,
          });
          replyText = `利用日を ${userText} で受け付けました。開始時間を HH:MM 形式で送ってください。例: 18:00`;
        }
      } else {
        sessions.set(userId, {
          ...session,
          step: 'waiting_start_time',
          date: userText,
        });
        replyText = `利用日を ${userText} で受け付けました。開始時間を HH:MM 形式で送ってください。例: 18:00`;
      }
    } else {
      replyText = '日付の形式が違います。YYYY-MM-DD 形式で送ってください。例: 2026-05-03';
    }

  } else if (session && session.step === 'waiting_start_time') {
    if (/^\d{2}:\d{2}$/.test(userText)) {
      sessions.set(userId, {
        ...session,
        step: 'waiting_end_time',
        startTime: userText,
      });
      replyText = `開始時間を ${userText} で受け付けました。終了時間を HH:MM 形式で送ってください。例: 19:00`;
    } else {
      replyText = '時間の形式が違います。HH:MM 形式で送ってください。例: 18:00';
    }

  } else if (session && session.step === 'waiting_end_time') {
    if (/^\d{2}:\d{2}$/.test(userText)) {
      const date = session.date;
      const startTime = session.startTime;
      const endTime = userText;
      const reservationType = session.reservationType;
      const userName = session.userName;

      sessions.delete(userId);

      try {
        const response = await axios.post(process.env.GAS_WEB_APP_URL, {
          action: 'create',
          title: reservationType === 'block' ? '予約禁止期間' : userName,
          date: date,
          startTime: startTime,
          endTime: endTime,
          userName: reservationType === 'block' ? '予約禁止期間' : userName,
          lineUserId: userId,
          isBlock: reservationType === 'block',
        });

        const result = response.data;

        if (result.ok) {
          if (reservationType === 'block') {
            replyText =
              '予約禁止期間を登録しました。\n' +
              `利用日: ${date}\n` +
              `開始時間: ${startTime}\n` +
              `終了時間: ${endTime}`;
          } else {
            replyText =
              '予約が完了しました。\n' +
              `登録名: ${userName}\n` +
              `利用日: ${date}\n` +
              `開始時間: ${startTime}\n` +
              `終了時間: ${endTime}`;
          }
        } else {
          replyText =
            (reservationType === 'block'
              ? '予約禁止期間を登録できませんでした。\n'
              : '予約できませんでした。\n') +
            (result.message || '不明なエラーです。');

          if (result.busyTimes && result.busyTimes.length > 0) {
            replyText += '\n重複時間: ' + result.busyTimes.join(', ');
          }
        }
      } catch (error) {
        console.error('GAS create error:', error.response?.data || error.message);
        replyText = reservationType === 'block'
          ? '予約禁止期間の登録中にエラーが発生しました。'
          : 'Googleカレンダーへの登録中にエラーが発生しました。';
      }
    } else {
      replyText = '時間の形式が違います。HH:MM 形式で送ってください。例: 19:00';
    }

  } else {
    replyText = '「名前登録」「名前確認」「予約」「予約確認」「取消」「予約状況」のいずれかを送ってください。';
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: replyText,
      },
    ],
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port ${process.env.PORT || 3000}`);
});