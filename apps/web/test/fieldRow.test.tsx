import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FieldRow } from "../src/components/FieldRow";
import { SourcePanel } from "../src/components/SourcePanel";
import type { FieldView } from "../src/lib/types";

const field = (over: Partial<FieldView> = {}): FieldView => ({
  name: "noticeDaysToVacate",
  value: 60,
  status: "extracted",
  sourceRef: { page: 4, quote: "give written notice at least sixty (60) days before the end" },
  isDate: true,
  ...over,
});

const noop = async () => undefined;
const props = { onSelect: () => undefined, onConfirm: noop, onEdit: noop };

describe("FieldRow states", () => {
  it("an unconfirmed field says so in words, shows value, quote and page, and offers Confirm", () => {
    const { container } = render(<FieldRow field={field()} {...props} />);
    expect(container.querySelector("[data-status='extracted']")).not.toBeNull();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText(/sixty \(60\) days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Page 4/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm/ })).toBeInTheDocument();
  });

  it("a confirmed field says Confirmed and has no Confirm button", () => {
    render(<FieldRow field={field({ status: "confirmed" })} {...props} />);
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
  });

  it("an edited field says Edited", () => {
    render(<FieldRow field={field({ status: "edited" })} {...props} />);
    expect(screen.getByText("Edited")).toBeInTheDocument();
  });

  it("clicking the page chip asks to open that page with the quote", async () => {
    const onSelect = vi.fn();
    render(<FieldRow field={field()} {...props} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /Page 4/ }));
    expect(onSelect).toHaveBeenCalledWith({ page: 4, quote: expect.stringContaining("sixty") });
  });

  it("edit sends the new value, and shows the server message when it is refused", async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error("That value does not fit this field."));
    render(<FieldRow field={field()} {...props} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const box = screen.getByLabelText(/New value/);
    await userEvent.clear(box);
    await userEvent.type(box, "-5");
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(onEdit).toHaveBeenCalledWith("noticeDaysToVacate", -5);
    expect(await screen.findByRole("alert")).toHaveTextContent("That value does not fit this field.");
  });

  it("a group is confirmable but not editable", () => {
    render(<FieldRow field={field({ name: "contact", value: { phone: "555 0100" }, isDate: false })} {...props} />);
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Confirm/ })).toBeInTheDocument();
    expect(screen.getByText(/Phone: 555 0100/)).toBeInTheDocument();
  });
});

describe("document text is only ever text", () => {
  const hostile = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>';

  it("a hostile field value and quote appear as literal text and nothing executes", () => {
    const { container } = render(
      <FieldRow
        field={field({ name: "landlord", value: hostile, isDate: false, sourceRef: { page: 1, quote: hostile } })}
        {...props}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(hostile, { exact: false }).length).toBeGreaterThanOrEqual(2);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("hostile page text is literal, with the quote highlighted in a mark element", () => {
    const text = `Intro ${hostile} more. The quoted clause sits here. End.`;
    const { container } = render(<SourcePanel page={2} text={text} quote="The quoted clause sits here." />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("The quoted clause sits here.");
    expect(container.textContent).toContain(hostile);
  });

  it("finds a quote even when line breaks differ", () => {
    const { container } = render(
      <SourcePanel page={1} text={"Tenant must give\nnotice now."} quote="Tenant must give notice now." />,
    );
    expect(container.querySelector("mark")).not.toBeNull();
  });

  it("says plainly when the quote is not on the page", () => {
    render(<SourcePanel page={1} text="Nothing here." quote="Something else" />);
    expect(screen.getByText(/could not find the exact quote/i)).toBeInTheDocument();
  });
});
