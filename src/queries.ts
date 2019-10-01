import { sdk } from "./sdk"
import {
  ILookmlModel,
  ILookmlModelExplore,
  ILookmlModelExploreField
} from "@looker/sdk/dist/sdk/models"

interface FieldInfo {
  model: ILookmlModel
  explore: ILookmlModelExplore
  field: ILookmlModelExploreField
}

export interface QueryChartTypeTopValues extends FieldInfo {
  type: "Values" | "Distribution"
}

export type QueryChartType = QueryChartTypeTopValues

export interface SimpleDatum {
  v: string
  l?: string
  n?: number
}

export interface SimpleResult {
  align: ("left" | "right")[]
  data: SimpleDatum[][]
  max: (number | undefined)[]
  aux?: string
  histogram?: Histogram
}

export interface Histogram {
  data: { value: number; min: number; max: number }[]
}

const cache = {}
async function localCache<T>(key: string, getter: () => Promise<T>) {
  if (!cache[key]) {
    cache[key] = await getter()
  }
  return cache[key]
}
export function getCached(key: string) {
  return cache[key]
}

export async function runChartQuery(
  type: QueryChartType
): Promise<SimpleResult> {
  if (type.type == "Values") {
    const result = await localCache(JSON.stringify(type), () =>
      getTopValues(type)
    )
    return result
  } else if (type.type == "Distribution") {
    const result = await localCache(JSON.stringify(type), () =>
      getDistribution(type)
    )
    return result
  }
}

function formatData(d: any): SimpleDatum {
  const link = d.links && d.links[0] && d.links[0].url
  const string = d.rendered || `${d.value}`
  const number = typeof d.value === "number" ? d.value : undefined
  return { v: string, l: link, n: number }
}

export function countFieldForField({
  explore,
  field
}: {
  explore: ILookmlModelExplore
  field: ILookmlModelExploreField
}): ILookmlModelExploreField | undefined {
  return explore.fields.measures.filter(
    f => f.label_short === "Count" && f.view_label == field.view_label
  )[0]
}

export function canGetTopValues({
  model,
  explore,
  field
}: {
  model: ILookmlModel
  explore: ILookmlModelExplore
  field: ILookmlModelExploreField
}) {
  return (
    field.category === "dimension" && !!countFieldForField({ explore, field })
  )
}

export function canGetDistribution({
  model,
  explore,
  field
}: {
  model: ILookmlModel
  explore: ILookmlModelExplore
  field: ILookmlModelExploreField
}) {
  return field.type == "number" && field.category === "dimension"
}

export async function getTopValues({
  model,
  explore,
  field
}: {
  model: ILookmlModel
  explore: ILookmlModelExplore
  field: ILookmlModelExploreField
}): Promise<SimpleResult> {
  const countField = countFieldForField({ explore, field })!
  const qr: any = await sdk.ok(
    sdk.run_inline_query({
      result_format: "json_detail",
      limit: 10,
      body: {
        total: true,
        model: model.name,
        view: explore.name,
        fields: [field.name, countField.name],
        sorts: [`${countField.name} desc`]
      }
    })
  )
  const data = qr.data.map(row => [
    formatData(row[field.name]),
    formatData(row[countField.name])
  ])
  return {
    align: ["left", "right"],
    data,
    max: [undefined, +data[0][1].n],
    aux: `${qr.totals_data[countField.name].value.toLocaleString()} rows`
  }
}

export async function getDistribution({
  model,
  explore,
  field
}: {
  model: ILookmlModel
  explore: ILookmlModelExplore
  field: ILookmlModelExploreField
}): Promise<SimpleResult> {
  const countField = countFieldForField({ explore, field })!
  const qr: any = await sdk.ok(
    sdk.run_inline_query({
      result_format: "json_detail",
      limit: 10,
      body: {
        model: model.name,
        view: explore.name,
        fields: ["min", "max", "average"],
        dynamic_fields: JSON.stringify([
          {
            measure: "min",
            type: "min",
            based_on: field.name
          },
          {
            measure: "max",
            type: "max",
            based_on: field.name
          },
          {
            measure: "average",
            type: "average",
            based_on: field.name
          }
        ])
      }
    })
  )
  const min = qr.data[0].min
  const max = qr.data[0].max
  const average = qr.data[0].average

  const binCount = 20
  const range = Math.abs(max.value - min.value)
  const binSize = range / binCount
  const bins: [number, number][] = []
  for (let i = 0; i < binCount; i++) {
    bins.push([min.value + binSize * i, min.value + binSize * (i + 1)])
  }

  let histogram
  if (min.value) {
    const ref = "${" + field.name + "}"
    const binClauses = bins
      .map(([min, max], i) => `if(${ref} <= ${max}, ${i}, null)`)
      .join(",\n")
    const binExpression = `coalesce(${binClauses})`

    const histogramQR: any = await sdk.ok(
      sdk.run_inline_query({
        result_format: "json_detail",
        limit: 10,
        body: {
          model: model.name,
          view: explore.name,
          fields: ["bin", countField.name],
          dynamic_fields: JSON.stringify([
            { dimension: "bin", expression: binExpression }
          ])
        }
      })
    )

    histogram = {
      data: bins.map(([min, max], i) => {
        const row = histogramQR.data.filter(d => d.bin.value == i)[0]
        return {
          value: row ? row[countField.name].value : 0,
          min,
          max
        }
      })
    }
  }

  return {
    align: ["left", "right"],
    histogram,
    data: [
      [{ v: "Min" }, { v: min.value && min.value.toLocaleString() }],
      [{ v: "Max" }, { v: max.value && max.value.toLocaleString() }],
      [{ v: "Average" }, { v: average.value && average.value.toLocaleString() }]
    ],
    max: [undefined, undefined]
  }
}

// export async function getFieldUsage(
//   model: ILookmlModel,
//   explore: ILookmlModelExplore,
//   field: ILookmlModelExploreField
// ): SimpleResult {
//   const qr: any = sdk.ok(
//     sdk.run_inline_query({
//       body: {
//         model: "i__looker",
//         view: "history",
//         filters: {
//           "query.model": JSON.stringify(model.name),
//           "query.view": JSON.stringify(explore.name),
//           "query.formatted_fields": `%${JSON.stringify(field.name)}%`
//         },
//         fields: ["query.formatted_fields", "query.count"]
//       }
//     })
//   )
//   return qr.data.map(row => [row[]])
// }

// https://localhost:9999/explore/i__looker/history?fields=query.model,query.view,query.formatted_fields,query.count&sorts=query.count+desc&limit=500&query_timezone=America%2FLos_Angeles&vis=%7B%7D&filter_config=%7B%7D&dynamic_fields=%5B%5D&origin=share-expanded