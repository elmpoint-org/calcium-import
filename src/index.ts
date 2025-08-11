import { readFile, writeFile } from 'node:fs/promises';

import ical from 'ical.js';
import { z } from 'zod';

import dayjs, { Dayjs } from 'dayjs';
import dayjsObj from 'dayjs/plugin/objectSupport';
import dayjsUTC from 'dayjs/plugin/utc';
dayjs.extend(dayjsObj);
dayjs.extend(dayjsUTC);

import { validate } from './validate';
import path from 'node:path';

import 'dotenv/config';

function prettyPrint(obj: unknown) {
  console.log(JSON.stringify(obj, undefined, 2));
}

const cabinMap = {
  Foster: '45617389-7678-42bf-bfb4-83304a389dc7',
  House: '430a512f-6a35-4ed0-9e4b-4efa7a90a0e7',
  Ide: 'd0b162c0-8a64-4946-b148-a7362c296709',
  Kendrew: '2bb998a2-7c9a-4367-bcdb-b8e8a144b8a7',
  Meeting: null,
  Mosher: '649d65b6-9a50-491f-b0f2-8a0e22ee6275',
};
const cabins = Object.keys(cabinMap) as (keyof typeof cabinMap)[];
const cabinShape = z.union([
  z.never(),
  z.never(),
  ...cabins.map((c) => z.literal(c)),
]);

const dateShape = z.object({
  isDate: z.literal(true),
  year: z.number(),
  month: z.number(),
  day: z.number(),
});
const shape = z.object({
  uid: z.string().transform(extractCalciumId),
  summary: z.string().transform(fixApostrophe),
  dtstart: dateShape,
  dtend: dateShape.optional(),
  categories: cabinShape.optional(),
  description: z.string().optional().transform(fixApostrophe),
  rrule: z
    .object({
      freq: z.literal('DAILY'),
      until: dateShape,
    })
    .optional(),
});

function fixApostrophe(str?: string) {
  if (!str?.length) return;
  return str.replace(/[�]/g, '’');
}

function extractCalciumId(id: string) {
  return id.replace(/^1754931775-(\w+)-515570@afosterri.org$/, '$1');
}

function parseDate(obj: z.infer<typeof dateShape>) {
  return dayjs({
    year: obj.year,
    month: obj.month - 1,
    day: obj.day,
  });
}
function formatDate(obj: Dayjs) {
  return obj.format('YYYY-MM-DD');
}
function parseFormatDate(obj: z.infer<typeof dateShape>) {
  return formatDate(parseDate(obj));
}

export type Events = {
  title: string;
  description: string | undefined;
  cabin:
    | 'Foster'
    | 'House'
    | 'Ide'
    | 'Kendrew'
    | 'Meeting'
    | 'Mosher'
    | undefined;
  dates: {
    start: string;
    end: string;
  };
};

async function ImportICS(newDownload: boolean = false) {
  const filepath = path.join(__dirname, '../assets/CalciumEvents.ics');

  // FETCH CALCIUM
  if (newDownload) {
    const datadown = await fetch(process.env.CALCIUM_URL!, {})
      .then((resp) => resp.text())
      .catch((e) => console.log(e));
    if (!datadown) return;
    await writeFile(filepath, datadown);
  }

  const data = (await readFile(filepath).catch(() => {}))?.toString();
  if (!data) return;

  // convert to object
  const cc = new ical.Component(ical.parse(data) as any, undefined);
  const events = cc.getAllSubcomponents('vevent');

  // PARSE
  let broken: any[] = [];
  let unparsed = [];
  const parsed = events
    .map((c, i) => {
      let obj: any = {};
      try {
        for (const prop of c.getAllProperties()) {
          if (prop.name === 'exdate') continue;
          obj[prop.name] = prop.getValues()[0];
        }
      } catch (e) {
        broken.push({
          number: i,
          object: Object.assign({}, c.getAllProperties()),
          error: e,
        });
        return;
      }

      const { data, error } = validate(obj, shape);
      if (error || !data) {
        unparsed.push({
          number: i,
          object: Object.assign({}, obj),
          error: error,
        });
        return;
      }

      return {
        importId: data.uid,
        title: data.summary,
        description: data.description,
        cabin: (data.categories && cabinMap[data.categories]) ?? null,
        dates: {
          start: parseFormatDate(data.dtstart),
          end: data.rrule
            ? parseFormatDate(data.rrule.until)
            : formatDate(parseDate(data.dtstart) /* .add(1, 'day') */),
        },
      };
    })
    .filter((it) => !!it);

  // DISPLAY

  console.log('BROKEN: ', broken.length);
  // prettyPrint(broken.slice(0, 50));

  console.log('UNPARSED: ', unparsed.length);
  // prettyPrint(unparsed.slice(0,1))

  const rr = parsed.filter((c) => !c.dates.end);
  console.log('NO END DAY:', rr.length);
  // console.log(rr.slice(rr.length - 50));

  console.log('PARSED: ', parsed.length);
  // console.log(parsed.slice(parsed.length - 50));
  // console.log(parsed[240]);

  // write to file
  writeFile(
    path.join(__dirname, '../assets/IMPORT.json'),
    JSON.stringify({ events: parsed })
  );

  return parsed;
}

//  --------------------------------------------------------------

// uploadData();
async function uploadData(newDownload: boolean = false) {
  const parsed = await ImportICS(newDownload);
  if (!parsed) return;

  const finalEvents = parsed.map((event) => ({
    title: event.title,
    description: event.description ?? '',
    authorId: '3ede5331-ab2d-46b6-89b4-dd68d0d4e2a0',
    dateStart: stringToTS(event.dates.start),
    dateEnd: stringToTS(event.dates.end),
    reservations: [
      {
        name: event.title,
        roomId: event.cabin ?? undefined,
        customText: !event.cabin?.length ? 'Custom Event' : undefined,
      },
    ],
    importId: event.importId,
  }));

  const resp = await fetch(
    'https://luforumi80.execute-api.us-east-1.amazonaws.com/gql',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer ' + process.env.EPC_TOKEN,
      },
      body: JSON.stringify({
        query: `
            mutation StayCreateMultiple($stays: [StayCreateMultipleInput!]!) {
              stayCreateMultiple(stays: $stays) {
                id
              }
            }`,
        variables: { stays: finalEvents },
      }),
    }
  )
    .then((resp) => resp.json())
    .catch((err) => console.error(err));
  prettyPrint(resp);
}

/** convert to date timestamp.
 *
 * **By default, `isInputNotUTC` is true**, meaning the date from your current timezone will be taken. set to `false` to take the date at UTC time. */
function dateTS(d: Date | number, isInputNotUTC: boolean = true) {
  const day = d instanceof Date ? dayjs(d) : dayjs.unix(d);
  return day.utc(isInputNotUTC).startOf('date').unix();
}

function stringToTS(d: string) {
  return dateTS(dayjs(d, 'YYYY-MM-DD').unix());
}

// RUNS

// ImportICS(true);
// uploadData(false);
