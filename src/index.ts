import * as _ from 'lodash'
import * as T from './types'
import * as Pg from 'pg'
import * as P from './parser'
import * as Util from './util'
import { EventEmitter } from 'events'
import * as Url from 'url'

const Case = require('case')
const Uuid = require('node-uuid')
const PgFormat = require('pg-format')

const TINYPG_LOG = process.env.TINYPG_LOG === 'true'

Pg.defaults['poolLog'] = TINYPG_LOG ? m => { console.log(`PG: ${m}`) } : _.identity

export class TinyPg {
   options: T.TinyPgOptions
   pool: Pg.Pool
   sql_files: T.SqlFile[]
   sql_db_calls: _.Dictionary<DbCall>
   events: EventEmitter

   constructor(options: Partial<T.TinyPgOptions>) {
      this.options = <T.TinyPgOptions> {
         snake: false,
         error_transformer: _.identity,
         root_dir: [],
         ...options
      }

      this.events = new EventEmitter()

      const params = Url.parse(options.connection_string, true)
      const auth = params.auth.split(':')

      const pool_config: Pg.PoolConfig = {
         user: auth[0],
         password: auth[1],
         host: params.hostname,
         port: parseInt(params.port, 10),
         database: params.pathname.split('/')[1],
         ssl: params.query.sslmode === 'require',
      }

      this.pool = new Pg.Pool(pool_config)

      const path_transformer = this.options.snake
         ? Case.snake.bind(Case)
         : Case.camel.bind(Case)

      this.sql_files = P.parseFiles([].concat(this.options.root_dir), path_transformer)

      this.sql_db_calls = _.keyBy(_.map(this.sql_files, sql_file => {
         return new DbCall({
            name: sql_file.name,
            key: sql_file.key,
            text: sql_file.text,
            parameterized_query: sql_file.parsed.parameterized_sql,
            parameter_map: sql_file.parsed.mapping,
            prepared: true
         })
      }), x => x.config.key)
   }

   query<T>(raw_sql: string, params: Object = {}): Promise<T.Result<T>> {
      const stack_trace_accessor = Util.stackTraceAccessor()

      TINYPG_LOG && console.log('TINYPG: query')
      return Promise.resolve()
      .then(() => {
         const parsed = P.parseSql(raw_sql)

         const db_call = new DbCall({
            name: 'raw_query',
            key: null,
            text: raw_sql,
            parameterized_query: parsed.parameterized_sql,
            parameter_map: parsed.mapping,
            prepared: false,
         })

         return this.performDbCall(stack_trace_accessor, db_call, params)
      })
   }

   sql<T>(name: string, params: Object = {}): Promise<T.Result<T>> {
      const stack_trace_accessor = Util.stackTraceAccessor()

      TINYPG_LOG && console.log('TINYPG: sql', name)
      const db_call: DbCall = this.sql_db_calls[name]

      if (_.isNil(db_call)) {
         return Promise.reject(new Error(`Sql query with name [${name}] not found!`))
      }

      return this.performDbCall<T>(stack_trace_accessor, db_call, params)
   }

   formattable(name: string): FormattableDbCall {
      const db_call: DbCall = this.sql_db_calls[name]

      if (_.isNil(db_call)) {
         throw new Error(`Sql query with name [${name}] not found!`)
      }

      return new FormattableDbCall(db_call, this)
   }

   transaction<T>(tx_fn: (db: TinyPg) => Promise<T>): Promise<T> {
      TINYPG_LOG && console.log('TINYPG: transaction')
      return this.getClientContext()
      .then(transaction_context => {
         TINYPG_LOG && console.log('TINYPG: BEGIN transaction')
         return transaction_context.client.query('BEGIN')
         .then(() => {
            const tiny_client_overrides: Partial<T.ClientContext> = {
               release: _.identity,
            }

            const unreleasable_client = _.create(transaction_context, tiny_client_overrides)

            const tiny_overrides: Partial<TinyPg> = {
               transaction: f => {
                  TINYPG_LOG && console.log('TINYPG: inner transaction')
                  return f(tiny_tx)
               },
               getClientContext: () => {
                  TINYPG_LOG && console.log('TINYPG: getClientContext (transaction)')
                  return Promise.resolve(unreleasable_client)
               },
            }

            const tiny_tx = _.create(this, tiny_overrides)

            return tx_fn(tiny_tx)
            .then(result => {
               TINYPG_LOG && console.log('TINYPG: COMMIT transaction')
               return transaction_context.client.query('COMMIT')
               .then(() => {
                  TINYPG_LOG && console.log('TINYPG: release transaction client')
                  transaction_context.release()
                  return result
               })
            })
         })
         .catch(error => {
            const releaseAndThrow = () => {
               TINYPG_LOG && console.log('TINYPG: release transaction client')
               transaction_context.release()
               throw error
            }

            TINYPG_LOG && console.log('TINYPG: ROLLBACK transaction')
            return transaction_context.client.query('ROLLBACK')
            .then(releaseAndThrow)
            .catch(releaseAndThrow)
         })
      })
   }

   getClientContext(): Promise<T.ClientContext> {
      TINYPG_LOG && console.log('TINYPG: getClient')
      return this.pool.connect()
      .then(client => {
         return {
            client,
            release: client.release.bind(client),
         }
      })
   }

   isolatedEmitter(): T.Disposable & TinyPg {
      const tiny_overrides: Partial<TinyPg> = {
         events: new EventEmitter(),
      }

      return _.create(TinyPg.prototype, _.extend<T.Disposable>({
         dispose: function () {
            this.events.removeAllListeners()
         },
      }, this, tiny_overrides))
   }

   performDbCall<T>(stack_trace_accessor: T.StackTraceAccessor, db_call: DbCall, params: Object) {
      TINYPG_LOG && console.log('TINYPG: performDbCall', db_call.config.name)

      return this.getClientContext()
      .then((client: T.ClientContext) => {
         const start_at = Date.now()

         const query_context = {
            id: Uuid.v4(),
            sql: db_call.config.parameterized_query,
            start: start_at,
            name: db_call.config.name,
            params,
         }

         this.events.emit('query', query_context)

         const callComplete = (error, data) => {
            client.release()

            const end_at = Date.now()

            _.assign(query_context, {
               end: end_at,
               duration: end_at - start_at,
               error: error,
               data: data,
            })

            this.events.emit('result', query_context)
         }

         return db_call.execute<T>(client, params)
         .then(result => {
            callComplete(null, result)
            return result
         })
         .catch(error => {
            callComplete(error, null)

            const tiny_error = new T.TinyPgError(error.message)
            tiny_error.stack = stack_trace_accessor.stack
            tiny_error.queryContext = query_context
            throw this.options.error_transformer(tiny_error)
         })
      })
   }
}

export class DbCall {
   config: T.DbCallConfig
   prepared_name?: string

   constructor(config: T.DbCallConfig) {
      this.config = config

      if (this.config.prepared) {
         this.prepared_name = `${config.name}_${Util.hashCode(config.parameterized_query).toString().replace('-', 'n')}`.substring(0, 63)
      }
   }

   execute<T>(client: T.ClientContext, params: Object): Promise<T.Result<T>> {
      return Promise.resolve()
      .then(() => {
         TINYPG_LOG && console.log('TINYPG: executing', this.config.name)

         const values: any[] = _.map(this.config.parameter_map, m => {
            if (!_.has(params, m.name)) {
               throw new Error('Missing expected key [' + m.name + '] on input parameters.')
            }

            return _.get(params, m.name)
         })

         const query = this.config.prepared
            ? client.client.query({ name: this.prepared_name, text: this.config.parameterized_query, values })
            : client.client.query(this.config.parameterized_query, values)

         return query
         .then((query_result: Pg.QueryResult): T.Result<T> => {
            TINYPG_LOG && console.log('TINYPG: execute result', this.config.name)
            return {
               ...query_result,
               rows: query_result.rows,
            }
         })
      })
   }
}

export class FormattableDbCall {
   db: TinyPg
   db_call: DbCall

   constructor(db_call: DbCall, tiny: TinyPg) {
      this.db = tiny
      this.db_call = db_call
   }

   format(...args: any[]): FormattableDbCall {
      const formatted_sql = PgFormat(this.db_call.config.text, ...args)
      const parsed = P.parseSql(formatted_sql)

      const new_db_call = new DbCall({
         ...this.db_call.config,
         text: formatted_sql,
         parameterized_query: parsed.parameterized_sql,
         parameter_map: parsed.mapping,
      })

      return new FormattableDbCall(new_db_call, this.db)
   }

   query<T>(params: Object = {}): Promise<T.Result<T>> {
      const stack_trace_accessor = Util.stackTraceAccessor()

      return this.db.performDbCall<T>(stack_trace_accessor, this.db_call, params)
   }

   static pg: any = Pg

   static pgDefaults = obj => {
      for (let k in obj) {
         if (obj.hasOwnProperty(k)) {
            Pg.defaults[k] = obj[k]
         }
      }
   }
}

export default TinyPg
