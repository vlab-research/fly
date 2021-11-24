<script>
    import { navigate } from "svelte-routing";

    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";

    import getIndex from "../utils/getIndex.js";

    export let ref, fields;

    const setFirstRef = (index) => {
        return fields[index].ref;
    };

    ref = setFirstRef(0);

    navigate(`/${ref}`, { replace: true });

    let index = getIndex(fields, ref);

    let field = fields[index];
</script>

<div class="surveyapp stack-large">
    <div class="stack-small" />
    <form>
        <div class="stack-small">
            <!-- Question -->
            {#if field}
                <h2 class="label-wrapper">
                    <label for="question-{index + 1}">Question
                        {index + 1}
                        out of
                        {fields.length}</label>
                </h2>
                {#if field.type === 'short_text'}
                    <ShortText {field} />
                {:else if field.type === 'multiple_choice'}
                    <MultipleChoice {field} />
                {/if}
            {/if}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
