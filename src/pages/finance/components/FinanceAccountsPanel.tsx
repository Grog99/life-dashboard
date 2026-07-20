import { type CSSProperties } from "react";
import { ArrowRight, Landmark, LockKeyhole, Plus, Users, Wallet } from "lucide-react";
import type { FinanceAccount, FinanceTransaction } from "../../../financeTypes";
import type { HouseholdMember } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";
import { accountTypeMeta } from "../financeConstants";

interface FinanceAccountsPanelProps {
  activeAccounts: FinanceAccount[];
  accountFilter: string;
  financeTransactions: FinanceTransaction[];
  memberById: Map<string, HouseholdMember>;
  hideAmounts: boolean;
  onSelectAccount: (accountId: string) => void;
  onAddAccount: () => void;
}

export function FinanceAccountsPanel({
  activeAccounts,
  accountFilter,
  financeTransactions,
  memberById,
  hideAmounts,
  onSelectAccount,
  onAddAccount,
}: FinanceAccountsPanelProps) {
  return (
    <section className="panel finance-accounts-panel">
      <header className="panel__header panel__header--compact finance-section-heading">
        <div>
          <span className="section-kicker">
            <Landmark size={14} /> Rachunki
          </span>
          <h2>Twoje pieniądze</h2>
        </div>
        <button className="text-button" type="button" onClick={onAddAccount}>
          <Plus size={15} /> Nowy rachunek
        </button>
      </header>
      {activeAccounts.length ? (
        <div className="finance-account-grid">
          {activeAccounts.map((account) => {
            const meta = accountTypeMeta[account.type];
            const AccountIcon = meta.icon;
            const member = memberById.get(account.ownerId);
            const accountTransactionCount = financeTransactions.filter(
              (transaction) => transaction.accountId === account.id,
            ).length;
            return (
              <button
                className={`finance-account-card${accountFilter === account.id ? " is-selected" : ""}`}
                type="button"
                key={account.id}
                onClick={() => onSelectAccount(account.id)}
                aria-pressed={accountFilter === account.id}
                style={{ "--account-color": account.color } as CSSProperties}
              >
                <span className="finance-account-card__icon">
                  <AccountIcon size={19} />
                </span>
                <span className="finance-account-card__meta">
                  <small>{meta.label}</small>
                  <strong>{account.name}</strong>
                </span>
                <span className="finance-account-card__balance">
                  <strong>{formatMoney(account.balanceMinor, account.currency, hideAmounts)}</strong>
                  <small>
                    {account.visibility === "household" ? (
                      <Users size={12} />
                    ) : (
                      <LockKeyhole size={12} />
                    )}
                    {account.visibility === "household" ? "Wspólne" : (member?.name ?? "Prywatne")}
                    <span aria-hidden="true">·</span> {accountTransactionCount} operacji
                  </small>
                </span>
                <ArrowRight className="finance-account-card__arrow" size={17} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="finance-inline-empty">
          <Wallet size={22} />
          <div>
            <strong>Dodaj pierwszy rachunek</strong>
            <span>Może to być konto, gotówka albo karta.</span>
          </div>
          <button className="button button--soft button--small" type="button" onClick={onAddAccount}>
            Dodaj rachunek
          </button>
        </div>
      )}
    </section>
  );
}
