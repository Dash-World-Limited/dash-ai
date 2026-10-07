@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.activity.result.contract
import android.net.Uri
abstract class ActivityResultContract<I, O>
class ActivityResultContracts {
    class OpenDocument : ActivityResultContract<Array<String>, Uri?>()
    class GetContent : ActivityResultContract<String, Uri?>()
    open class CreateDocument(mimeType: String) : ActivityResultContract<String, Uri?>()
    class RequestPermission : ActivityResultContract<String, Boolean>()
}
