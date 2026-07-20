import type { Dispatch, SetStateAction } from "react";
import { ArrowDownLeft, ArrowUpRight, Banknote, Plus, Search, Trash2, X } from "lucide-react";
import type { FinanceAccount, FinanceTransaction } from "../../../financeTypes";
import type { HouseholdMember } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";
import { formatDate, sourceLabels, type TransactionFilter } from "../financeConstants";

interface FinanceTransactionsPanelProps {
  filteredTransactions: FinanceTransaction[];
  visibleTransactions: number;
  setVisibleTransactions: Dispatch<SetStateAction<number>>;
  search: string;
  setSearch: (value: string) => void;
  accountFilter: string;
  setAccountFilter: (value: string) => void;
  transactionFilter: TransactionFilter;
  setTransactionFilter: (value: TransactionFilter) => void;
  activeAccounts: FinanceAccount[];
  accountById: Map<string, FinanceAccount>;
  memberById: Map<string, HouseholdMember>;
  hideAmounts: boolean;
  onRemoveTransaction: (transaction: FinanceTransaction) => void;
  onAddTransaction: () => void;
}

export function FinanceTransactionsPanel({
  filteredTransactions,
  visibleTransactions,
  setVisibleTransactions,
  search,
  setSearch,
  accountFilter,
  setAccountFilter,
  transactionFilter,
  setTransactionFilter,
  activeAccounts,
  accountById,
  memberById,
  hideAmounts,
  onRemoveTransaction,
  onAddTransaction,
}: FinanceTransactionsPanelProps) {
  return (
    <section className="panel finance-transactions-panel" id="finance-transactions">
      <header className="finance-transactions-header">
        <div>
          <span className="section-kicker">
            <Banknote size={14} /> Historia
          </span>
          <h2>Transakcje</h2>
          <p>{filteredTransactions.length} pasujących operacji</p>
        </div>
        <div className="finance-transaction-filters">
          <label className="search-field finance-search-field">
            <Search size={16} />
            <span className="sr-only">Szukaj transakcji</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setVisibleTransactions(8);
              }}
              placeholder="Szukaj transakcji…"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} aria-label="Wyczyść wyszukiwanie">
                <X size={14} />
              </button>
            )}
          </label>
          <label className="finance-filter-select">
            <span className="sr-only">Filtruj według rachunku</span>
            <select
              value={accountFilter}
              onChange={(event) => {
                setAccountFilter(event.target.value);
                setVisibleTransactions(8);
              }}
            >
              <option value="all">Wszystkie rachunki</option>
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label className="finance-filter-select finance-filter-select--short">
            <span className="sr-only">Filtruj według rodzaju</span>
            <select
              value={transactionFilter}
              onChange={(event) => {
                setTransactionFilter(event.target.value as TransactionFilter);
                setVisibleTransactions(8);
              }}
            >
              <option value="all">Wszystkie</option>
              <option value="expense">Wydatki</option>
              <option value="income">Wpływy</option>
            </select>
          </label>
        </div>
      </header>

      {filteredTransactions.length ? (
        <>
          <div className="finance-transactions-scroll">
            <table className="finance-transaction-table">
              <thead>
                <tr>
                  <th>Transakcja</th>
                  <th>Kategoria</th>
                  <th>Rachunek</th>
                  <th>Data</th>
                  <th>Kwota</th>
                  <th>
                    <span className="sr-only">Działania</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.slice(0, visibleTransactions).map((transaction) => {
                  const account = accountById.get(transaction.accountId);
                  const owner = memberById.get(transaction.ownerId);
                  const incoming = transaction.amountMinor > 0;
                  return (
                    <tr key={transaction.id}>
                      <td>
                        <div className="finance-transaction-name">
                          <span className={incoming ? "is-income" : "is-expense"}>
                            {incoming ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                          </span>
                          <div>
                            <strong>{transaction.title}</strong>
                            <small>
                              {transaction.merchant} <span aria-hidden="true">·</span>{" "}
                              {sourceLabels[transaction.source]}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="finance-category-pill">{transaction.category}</span>
                      </td>
                      <td>
                        <div className="finance-table-account">
                          <span style={{ background: account?.color }} />
                          <div>
                            <strong>{account?.name ?? "Usunięty rachunek"}</strong>
                            <small>{owner?.name ?? "Domownik"}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="finance-date-cell">
                          {formatDate(transaction.bookedOn, true)}
                        </span>
                      </td>
                      <td>
                        <strong
                          className={incoming ? "finance-amount is-positive" : "finance-amount"}
                        >
                          {formatMoney(transaction.amountMinor, transaction.currency, hideAmounts)}
                        </strong>
                      </td>
                      <td>
                        <button
                          className="icon-button finance-delete-transaction"
                          type="button"
                          onClick={() => onRemoveTransaction(transaction)}
                          aria-label={`Usuń transakcję ${transaction.title}`}
                          title="Usuń transakcję"
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {visibleTransactions < filteredTransactions.length && (
            <div className="finance-load-more">
              <button
                className="button button--ghost-border button--small"
                type="button"
                onClick={() => setVisibleTransactions((count) => count + 8)}
              >
                Pokaż więcej <ArrowDownLeft size={14} />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="finance-transactions-empty">
          <Search size={22} />
          <strong>Nie znaleziono transakcji</strong>
          <span>Zmień filtry albo dodaj nową operację.</span>
          <button
            className="button button--soft button--small"
            type="button"
            onClick={onAddTransaction}
          >
            <Plus size={15} /> Dodaj transakcję
          </button>
        </div>
      )}
    </section>
  );
}
