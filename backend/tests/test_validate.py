from app.graph import chain_edges
from app.schema import Step
from app.validate import error_count, validate_workflow


def step(id: str, type: str, **config: str) -> Step:
    return Step(id=id, type=type, name=f"{type} step", description="d", config=config)


def test_valid_linear_workflow_has_no_errors():
    steps = [step("a", "READ_CSV", file="x.csv"), step("b", "FILTER", condition="score < 50"), step("c", "OUTPUT", format="table")]
    assert error_count(validate_workflow(steps, chain_edges(steps))) == 0


def test_unsupported_operation_is_an_error():
    steps = [step("a", "READ_CSV", file="x.csv"), step("b", "MAGIC_ANALYSIS"), step("c", "OUTPUT", format="table")]
    messages = [i.message for i in validate_workflow(steps, chain_edges(steps))]
    assert any("Unsupported operation: MAGIC_ANALYSIS" in m for m in messages)


def test_missing_required_parameter_and_missing_output():
    steps = [step("a", "READ_CSV", file="x.csv"), step("b", "FILTER")]
    messages = [i.message for i in validate_workflow(steps, chain_edges(steps))]
    assert any("needs a value for" in m for m in messages)
    assert any("Output" in m for m in messages)


def test_disconnected_step_is_flagged():
    steps = [step("a", "READ_CSV", file="x.csv"), step("b", "FILTER", condition="x"), step("c", "OUTPUT", format="table")]
    issues = validate_workflow(steps, [])  # no edges at all
    assert any(i.nodeId == "b" and "no input connection" in i.message for i in issues)
